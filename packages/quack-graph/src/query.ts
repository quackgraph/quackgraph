import type { QuackGraph } from './graph';

type TraversalStep = {
  type: 'out' | 'in' | 'recursive';
  edge: string;
  direction?: 'out' | 'in';
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
   * Traverses the graph recursively (BFS) with depth bounds.
   * Useful for variable length paths like `(a)-[:KNOWS*1..5]->(b)`.
   * @param edgeType The edge label to follow.
   * @param options min/max depth (default: 1..5).
   * @param direction 'out' (default) or 'in'.
   */
  recursive(edgeType: string, options: { min?: number; max?: number } = {}, direction: 'out' | 'in' = 'out'): this {
    this.traversals.push({
      type: 'recursive',
      edge: edgeType,
      direction,
      bounds: {
        min: options.min ?? 1,
        max: options.max ?? 5,
      }
    });
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
      // Interpolate strict ISO string
      const iso = this.graph.context.asOf.toISOString();
      // DuckDB TIMESTAMP comparison works with ISO strings
      return `(${prefix}valid_from <= '${iso}' AND (${prefix}valid_to > '${iso}' OR ${prefix}valid_to IS NULL))`;
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
      // Requires: array_distance(embedding, [1,2,3])
      // DuckDB VSS extension syntax
      // Fallback: Use basic array operations since VSS extension has type compatibility issues
      // This implements a simple Euclidean distance calculation
      const vectorValues = this.vectorSearch.vector.map((v, i) => {
        const embeddingElement = `embedding[${i}]`;
        return `POW(COALESCE(${embeddingElement}, 0) - ${v}, 2)`;
      }).join(' + ');
      orderBy = `ORDER BY SQRT(${vectorValues})`;
      limit = `LIMIT ${this.vectorSearch.limit}`;
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
      if (currentIds.length === 0) break;
      
      if (step.type === 'recursive') {
        currentIds = this.graph.native.traverseRecursive(
          currentIds,
          step.edge,
          step.direction || 'out',
          step.bounds?.min,
          step.bounds?.max
        );
      } else {
        // step.type is 'out' | 'in'
        currentIds = this.graph.native.traverse(currentIds, step.edge, step.type as 'out' | 'in');
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