import { NativeGraph } from '@quackgraph/native';
import { DuckDBManager } from './db';
import { SchemaManager } from './schema';
import { QueryBuilder } from './query';

class WriteLock {
  private mutex: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain the new operation to the existing promise
    const result = this.mutex.then(() => fn());

    // Update the mutex to wait for the new operation to complete (success or failure)
    // We strictly return void so the mutex remains Promise<void>
    this.mutex = result.then(
      () => {},
      () => {}
    );

    return result;
  }
}

export class QuackGraph {
  db: DuckDBManager;
  schema: SchemaManager;
  native: NativeGraph;
  private writeLock = new WriteLock();
  
  capabilities = {
    vss: false
  };

  // Context for the current instance (Time Travel)
  context: {
    asOf?: Date;
    topologySnapshot?: string;
  } = {};

  constructor(path: string = ':memory:', options: { asOf?: Date, topologySnapshot?: string } = {}) {
    this.db = new DuckDBManager(path);
    this.schema = new SchemaManager(this.db);
    this.native = new NativeGraph();
    this.context.asOf = options.asOf;
    this.context.topologySnapshot = options.topologySnapshot;
  }

  async init() {
    await this.db.init();
    
    // Load Extensions
    try {
      await this.db.execute("INSTALL vss; LOAD vss;");
      this.capabilities.vss = true;
    } catch (e) {
      console.warn("QuackGraph: Failed to load 'vss' extension. Vector search will be disabled.", e);
    }
    
    await this.schema.ensureSchema();
    
    // If we are in time-travel mode, we might skip hydration or hydrate a snapshot (Advanced).
    // For V1, we always hydrate "Current Active" topology.

    // Check for Topology Snapshot
    if (this.context.topologySnapshot) {
      try {
        // Try loading from disk
        this.native.loadSnapshot(this.context.topologySnapshot);
        // If successful, skip hydration
        return;
      } catch (e) {
        console.warn(`QuackGraph: Failed to load snapshot '${this.context.topologySnapshot}'. Falling back to full hydration.`, e);
      }
    }

    try {
      await this.hydrate();
    } catch (e) {
      console.error("Failed to hydrate graph topology from disk:", e);
      // We don't throw here to allow partial functionality (metadata queries) if needed,
      // but usually this is fatal for graph operations.
      throw e;
    }
  }

  /**
   * Hydrates the in-memory Rust graph from the persistent DuckDB storage.
   * This is critical for the "Split-Brain" architecture.
   */
  async hydrate() {
    // Zero-Copy Arrow IPC
    // We load ALL edges (active and historical) to support time-travel.
    // We cast valid_from/valid_to to DOUBLE to ensure JS/JSON compatibility (avoiding BigInt issues in fallback)
    try {
      const ipcBuffer = await this.db.queryArrow(
        `SELECT source, target, type, 
                date_diff('us', '1970-01-01'::TIMESTAMPTZ, valid_from)::DOUBLE as valid_from, 
                date_diff('us', '1970-01-01'::TIMESTAMPTZ, valid_to)::DOUBLE as valid_to 
         FROM edges`
      );
    
      if (ipcBuffer && ipcBuffer.length > 0) {
         // Napi-rs expects a Buffer or equivalent
         // Buffer.from is zero-copy in Node for Uint8Array usually, or cheap copy
         // We cast to any to satisfy the generated TS definitions which might expect Buffer
         const bufferForNapi = Buffer.isBuffer(ipcBuffer) 
            ? ipcBuffer 
            : Buffer.from(ipcBuffer);
            
         this.native.loadArrowIpc(bufferForNapi);

         // Reclaim memory after burst hydration
         this.native.compact();
      }
    // biome-ignore lint/suspicious/noExplicitAny: error handling
    } catch (e: any) {
      throw new Error(`Hydration Error: ${e.message}`);
    }
  }

  asOf(date: Date): QuackGraph {
    // Return a shallow copy with new context
    const g = new QuackGraph(this.db.path, { asOf: date });
    // Share the same DB connection and Native index (assuming topology is shared/latest)
    g.db = this.db;
    g.schema = this.schema;
    g.native = this.native;
    g.capabilities = { ...this.capabilities };
    return g;
  }

  // --- Write Operations (Write-Through) ---

  // biome-ignore lint/suspicious/noExplicitAny: generic properties
  async addNode(id: string, labels: string[], props: Record<string, any> = {}) {
    await this.writeLock.run(async () => {
      // 1. Write to Disk (Source of Truth)
      await this.schema.writeNode(id, labels, props);
      // 2. Write to RAM (Cache)
      this.native.addNode(id);
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: generic properties
  async addEdge(source: string, target: string, type: string, props: Record<string, any> = {}) {
    await this.writeLock.run(async () => {
      // 1. Write to Disk
      await this.schema.writeEdge(source, target, type, props);
      // 2. Write to RAM (Current time)
      // We pass undefined for timestamps, so Rust defaults to (0, MAX) which is functionally "Active"
      this.native.addEdge(source, target, type, undefined, undefined);
    });
  }

  async deleteNode(id: string) {
    await this.writeLock.run(async () => {
      // 1. Write to Disk (Soft Delete)
      await this.schema.deleteNode(id);
      // 2. Write to RAM (Tombstone)
      this.native.removeNode(id);
    });
  }

  async deleteEdge(source: string, target: string, type: string) {
    await this.writeLock.run(async () => {
      // 1. Write to Disk (Soft Delete)
      await this.schema.deleteEdge(source, target, type);
      // 2. Write to RAM (Remove)
      this.native.removeEdge(source, target, type);
    });
  }

  /**
   * Upsert a node.
   * @param label Primary label to match.
   * @param matchProps Properties to match against (e.g. { email: '...' }).
   * @param setProps Properties to set/update if found or created.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Generic property bag
  async mergeNode(label: string, matchProps: Record<string, any>, setProps: Record<string, any> = {}) {
    return this.writeLock.run(async () => {
      const id = await this.schema.mergeNode(label, matchProps, setProps);
      // Update cache
      this.native.addNode(id);
      return id;
    });
  }

  // --- Optimization & Maintenance ---

  get optimize() {
    return {
      promoteProperty: async (label: string, property: string, type: string) => {
        await this.schema.promoteNodeProperty(label, property, type);
      },
      saveTopologySnapshot: (path: string) => {
        this.native.saveSnapshot(path);
      }
    };
  }

  // --- Read Operations ---

  match(labels: string[]): QueryBuilder {
    return new QueryBuilder(this, labels);
  }
}