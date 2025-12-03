import type { QuackGraph } from './graph';

type TraversalStep = {
  type: 'out' | 'in';
  edge: string;
  bounds?: { min: number; max: number };
};

export class QueryBuilder {
  private graph: QuackGraph;
  private startLabels: string[];
  private endLabels: string[] = [];

  // Bottom Bun Filters (Initial selection)
  // biome-ignore lint/suspicious/noExplicitAny: Generic filter criteria
  private initialFilters: Record<string, any> = {};
  private vectorSearch: { vector: number[]; limit: number } | null = null;

  // The Meat (Traversal)
  private traversals: TraversalStep[] = [];

  // Top Bun Filters (Final selection)
  // biome-ignore lint/suspicious/noExplicitAny: Generic filter criteria
  private terminalFilters: Record<string, any> = {};

  private aggState = {
    groupBy: [] as string[],
    orderBy: [] as { field: string; dir: 'ASC' | 'DESC' }[],
    limit: undefined as number | undefined,
    offset: undefined as number | undefined,
  };

  constructor(graph: QuackGraph, labels: string[]) {
    this.graph = graph;
    this.startLabels = labels;
  }

  /**
   * Sets depth bounds for the last traversal step.
   * Useful for variable length paths like `(a)-[:KNOWS*1..5]->(b)`.
   * Must be called immediately after .out() or .in().
   * @param min Minimum hops (default: 1)
   * @param max Maximum hops (default: 1)
   */
  depth(min: number, max: number): this {
    if (this.traversals.length === 0) {
      throw new Error("depth() must be called after a traversal step (.out() or .in())");
    }
    const lastIndex = this.traversals.length - 1;
    // biome-ignore lint/style/noNonNullAssertion: length check above ensures array is not empty
    const lastStep = this.traversals[lastIndex]!;
    lastStep.bounds = { min, max };
    return this;
  }

  /**
   * Filter nodes by properties.
   * If called before traversal, applies to Start Nodes.
   * If called after traversal, applies to End Nodes.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Generic filter criteria
  where(criteria: Record<string, any>): this {
    if (this.traversals.length === 0) {
      this.initialFilters = { ...this.initialFilters, ...criteria };
    } else {
      this.terminalFilters = { ...this.terminalFilters, ...criteria };
    }
    return this;
  }

  /**
   * Perform a Vector Similarity Search (HNSW).
   * This effectively sorts the start nodes by distance to the query vector.
   */
  nearText(vector: number[], options: { limit?: number } = {}): this {
    this.vectorSearch = { 
      vector, 
      limit: options.limit || 10 
    };
    return this;
  }

  out(edgeType: string): this {
    this.traversals.push({ type: 'out', edge: edgeType });
    return this;
  }

  in(edgeType: string): this {
    this.traversals.push({ type: 'in', edge: edgeType });
    return this;
  }

  groupBy(field: string): this {
    this.aggState.groupBy.push(field);
    return this;
  }

  orderBy(field: string, dir: 'ASC' | 'DESC' = 'ASC'): this {
    this.aggState.orderBy.push({ field, dir });
    return this;
  }

  limit(n: number): this {
    this.aggState.limit = n;
    return this;
  }

  offset(n: number): this {
    this.aggState.offset = n;
    return this;
  }

  /**
   * Filter the nodes at the end of the traversal by label.
   */
  node(labels: string[]): this {
    this.endLabels = labels;
    return this;
  }

  /**
   * Helper to construct the temporal validity clause
   */
  private getTemporalClause(tableAlias: string = ''): string {
    const prefix = tableAlias ? `${tableAlias}.` : '';
    if (this.graph.context.asOf) {
      // Time Travel: valid_from <= T AND (valid_to > T OR valid_to IS NULL)
      // Use microseconds since epoch for consistency with native layer
      const micros = this.graph.context.asOf.getTime() * 1000;
      // Convert database timestamps to microseconds for comparison
      return `(date_diff('us', '1970-01-01'::TIMESTAMPTZ, ${prefix}valid_from) <= ${micros} AND (date_diff('us', '1970-01-01'::TIMESTAMPTZ, ${prefix}valid_to) > ${micros} OR ${prefix}valid_to IS NULL))`;
    }
    // Default: Current valid records (valid_to is NULL)
    return `${prefix}valid_to IS NULL`;
  }

  /**
   * Executes the query.
   * @param projection Optional SQL projection string (e.g., 'count(*), avg(properties->>age)') or a JS mapper function.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Generic result mapper
  async select<T = any>(projection?: string | ((node: any) => T)): Promise<T[]> {
    const isRawSql = typeof projection === 'string';
    const mapper = typeof projection === 'function' ? projection : undefined;

    // --- Step 1: DuckDB Filter (Bottom Bun) ---
    // Objective: Get a list of "Active" Node IDs to feed into the graph.

    let query = `SELECT id FROM nodes`;
    // biome-ignore lint/suspicious/noExplicitAny: SQL parameters
    const params: any[] = [];
    const conditions: string[] = [];

    // 1.a Temporal Filter
    conditions.push(this.getTemporalClause());

    // 1.b Label Filter
    if (this.startLabels.length > 0) {
      // Check if ANY of the labels match. For V1 we check the first one or intersection.
      conditions.push(`list_contains(labels, ?)`);
      params.push(this.startLabels[0]);
    }

    // 1.c Property Filter
    for (const [key, value] of Object.entries(this.initialFilters)) {
      if (key === 'id') {
        conditions.push(`id = ?`);
        params.push(value);
      } else {
        conditions.push(`json_extract(properties, '$.${key}') = ?::JSON`);
        params.push(JSON.stringify(value));
      }
    }

    // 1.d Vector Search (Order By Distance)
    let orderBy = '';
    let limit = '';
    if (this.vectorSearch) {
      if (!this.graph.capabilities.vss) {
        throw new Error('Vector search requires the DuckDB "vss" extension, which is not available or failed to load.');
      }
      const vectorSize = this.vectorSearch.vector.length;
      orderBy = `ORDER BY array_distance(embedding::DOUBLE[${vectorSize}], ?::DOUBLE[${vectorSize}])`;
      limit = `LIMIT ${this.vectorSearch.limit}`;
      params.push(JSON.stringify(this.vectorSearch.vector));
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ${orderBy} ${limit}`;

    const startRows = await this.graph.db.query(query, params);
    let currentIds: string[] = startRows.map(row => row.id);

    if (currentIds.length === 0) return [];

    // --- Step 2: Rust Traversal (The Meat) ---
    // Note: Rust Graph Index is currently "Latest Topology Only". 
    // Time Travel on topology requires checking edge validity during traversal (V2).
    // For V1, we accept that traversal is instant/current, but properties are historical.

    for (const step of this.traversals) {
      const asOfTs = this.graph.context.asOf ? this.graph.context.asOf.getTime() * 1000 : undefined;

      if (currentIds.length === 0) break;
      
      if (step.bounds) {
        currentIds = this.graph.native.traverseRecursive(
          currentIds,
          step.edge,
          step.type,
          step.bounds.min,
          step.bounds.max,
          asOfTs
        );
      } else {
        // step.type is 'out' | 'in'
        currentIds = this.graph.native.traverse(currentIds, step.edge, step.type, asOfTs);
      }
    }

    // Optimization: If traversal resulted in no nodes, stop early.
    if (currentIds.length === 0) return [];

    // --- Step 3: DuckDB Hydration (Top Bun) ---
    // Objective: Fetch full properties for the resulting IDs, applying terminal filters.

    const finalConditions: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: SQL parameters
    const finalParams: any[] = [];

    // 3.0 Label Filter (for End Nodes)
    if (this.endLabels.length > 0) {
      finalConditions.push(`list_contains(labels, ?)`);
      finalParams.push(this.endLabels[0]);
    }

    // 3.a IDs match
    // We can't use parameters for IN clause effectively with dynamic length in all drivers.
    // Constructing placeholders.
    const placeholders = currentIds.map(() => '?').join(',');
    finalConditions.push(`id IN (${placeholders})`);
    finalParams.push(...currentIds);

    // 3.b Temporal Validity
    finalConditions.push(this.getTemporalClause());

    // 3.c Terminal Property Filters
    for (const [key, value] of Object.entries(this.terminalFilters)) {
      if (key === 'id') {
        finalConditions.push(`id = ?`);
        finalParams.push(value);
      } else {
        finalConditions.push(`json_extract(properties, '$.${key}') = ?::JSON`);
        finalParams.push(JSON.stringify(value));
      }
    }

    // 3.d Aggregation / Grouping / Ordering
    let selectClause = 'SELECT *';
    if (isRawSql) {
      selectClause = `SELECT ${projection}`;
    }

    let suffix = '';
    if (this.aggState.groupBy.length > 0) {
      suffix += ` GROUP BY ${this.aggState.groupBy.join(', ')}`;
    }
    
    if (this.aggState.orderBy.length > 0) {
      const orders = this.aggState.orderBy.map(o => `${o.field} ${o.dir}`).join(', ');
      suffix += ` ORDER BY ${orders}`;
    }

    if (this.aggState.limit !== undefined) {
      suffix += ` LIMIT ${this.aggState.limit}`;
    }
    if (this.aggState.offset !== undefined) {
      suffix += ` OFFSET ${this.aggState.offset}`;
    }

    const finalSql = `${selectClause} FROM nodes WHERE ${finalConditions.join(' AND ')} ${suffix}`;
    const results = await this.graph.db.query(finalSql, finalParams);

    return results.map(r => {
      if (isRawSql) return r;

      let props = r.properties;
      if (typeof props === 'string') {
        try { props = JSON.parse(props); } catch {}
      }
      const node = {
        id: r.id,
        labels: r.labels,
        ...props
      };
      return mapper ? mapper(node) : node;
    });
  }
}