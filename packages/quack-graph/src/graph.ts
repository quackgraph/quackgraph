import { NativeGraph } from '@quackgraph/native';
import { DuckDBManager } from './db';
import { SchemaManager } from './schema';
import { QueryBuilder } from './query';

export class QuackGraph {
  db: DuckDBManager;
  schema: SchemaManager;
  native: NativeGraph;
  
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
    // 'valid_to IS NULL' ensures we only load currently active edges.
    try {
      const ipcBuffer = await this.db.queryArrow(
        "SELECT source, target, type FROM edges WHERE valid_to IS NULL"
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
    // 1. Write to Disk (Source of Truth)
    await this.schema.writeNode(id, labels, props);
    // 2. Write to RAM (Cache)
    this.native.addNode(id);
  }

  // biome-ignore lint/suspicious/noExplicitAny: generic properties
  async addEdge(source: string, target: string, type: string, props: Record<string, any> = {}) {
    // 1. Write to Disk
    await this.schema.writeEdge(source, target, type, props);
    // 2. Write to RAM
    this.native.addEdge(source, target, type);
  }

  async deleteNode(id: string) {
    // 1. Write to Disk (Soft Delete)
    await this.schema.deleteNode(id);
    // 2. Write to RAM (Tombstone)
    this.native.removeNode(id);
  }

  async deleteEdge(source: string, target: string, type: string) {
    // 1. Write to Disk (Soft Delete)
    await this.schema.deleteEdge(source, target, type);
    // 2. Write to RAM (Remove)
    this.native.removeEdge(source, target, type);
  }

  /**
   * Upsert a node.
   * @param label Primary label to match.
   * @param matchProps Properties to match against (e.g. { email: '...' }).
   * @param setProps Properties to set/update if found or created.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Generic property bag
  async mergeNode(label: string, matchProps: Record<string, any>, setProps: Record<string, any> = {}) {
    const id = await this.schema.mergeNode(label, matchProps, setProps);
    // Update cache
    this.native.addNode(id);
    return id;
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