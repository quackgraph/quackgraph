import { Database } from 'duckdb-async';
import { tableFromJSON, tableToIPC } from 'apache-arrow';

// Interface for operations that can be performed within a transaction or globally
export interface DbExecutor {
  // biome-ignore lint/suspicious/noExplicitAny: SQL params are generic
  execute(sql: string, params?: any[]): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: SQL results are generic
  query(sql: string, params?: any[]): Promise<any[]>;
}

export class DuckDBManager implements DbExecutor {
  private db: Database | null = null;
  private _path: string;

  constructor(path: string = ':memory:') {
    this._path = path;
  }

  async init() {
    if (!this.db) {
      this.db = await Database.create(this._path);
    }
  }

  get path(): string {
    return this._path;
  }

  getDb(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db;
  }

  // biome-ignore lint/suspicious/noExplicitAny: SQL params
  async execute(sql: string, params: any[] = []): Promise<void> {
    const db = this.getDb();
    await db.run(sql, ...params);
  }

  // biome-ignore lint/suspicious/noExplicitAny: SQL results
  async query(sql: string, params: any[] = []): Promise<any[]> {
    const db = this.getDb();
    return await db.all(sql, ...params);
  }

  /**
   * Executes a callback within a transaction using a dedicated connection.
   * This guarantees that all operations inside the callback share the same ACID scope.
   */
  async transaction<T>(callback: (executor: DbExecutor) => Promise<T>): Promise<T> {
    const db = this.getDb();
    const conn = await db.connect();
    
    // Create a transaction-bound executor wrapper
    const txExecutor: DbExecutor = {
      // biome-ignore lint/suspicious/noExplicitAny: SQL params
      execute: async (sql: string, params: any[] = []) => {
        await conn.run(sql, ...params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: SQL results
      query: async (sql: string, params: any[] = []) => {
        return await conn.all(sql, ...params);
      }
    };

    try {
      await conn.run('BEGIN TRANSACTION');
      const result = await callback(txExecutor);
      await conn.run('COMMIT');
      return result;
    } catch (e) {
      try {
        await conn.run('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to rollback transaction:', rollbackError);
      }
      throw e;
    } finally {
      // Best effort close
      // biome-ignore lint/suspicious/noExplicitAny: DuckDB connection types are incomplete
      if (conn && typeof (conn as any).close === 'function') {
        // biome-ignore lint/suspicious/noExplicitAny: DuckDB connection types are incomplete
        (conn as any).close();
      }
    }
  }

  /**
   * Executes a query and returns the raw Apache Arrow IPC Buffer.
   * Used for high-speed hydration.
   */
  // biome-ignore lint/suspicious/noExplicitAny: SQL params
  async queryArrow(sql: string, params: any[] = []): Promise<Uint8Array> {
    const db = this.getDb();
    
    return new Promise((resolve, reject) => {
      // Hack: Access underlying node-duckdb connection/database
      // duckdb-async instance holds 'db' property which is the native Database
      // biome-ignore lint/suspicious/noExplicitAny: DuckDB internals
      const rawDb = (db as any).db || db;

      if (!rawDb) return reject(new Error("Could not access underlying DuckDB Native instance."));

      // Helper to merge multiple Arrow batches if necessary
      const mergeBatches = (batches: Uint8Array[]) => {
        if (batches.length === 0) return new Uint8Array(0);
        if (batches.length === 1) return batches[0] ?? new Uint8Array(0);
        const totalLength = batches.reduce((acc, val) => acc + val.length, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const batch of batches) {
          merged.set(batch, offset);
          offset += batch.length;
        }
        return merged;
      };

      const runFallback = async () => {
        try {
          const rows = await this.query(sql, params);
          if (rows.length === 0) return resolve(new Uint8Array(0));
          const table = tableFromJSON(rows);
          const ipc = tableToIPC(table, 'stream');
          resolve(ipc);
        } catch (e) {
          reject(e);
        }
      };

      // Try Database.arrowIPCAll (available in newer node-duckdb)
      if (typeof rawDb.arrowIPCAll === 'function') {
        // biome-ignore lint/suspicious/noExplicitAny: internal callback signature
        rawDb.arrowIPCAll(sql, ...params, (err: any, result: any) => {
          if (err) {
            const msg = String(err.message || '');
            if (msg.includes('to_arrow_ipc') || msg.includes('Table Function')) {
              return runFallback();
            }
            return reject(err);
          }
          // Result is usually Array<Uint8Array> (batches)
          if (Array.isArray(result)) {
            resolve(mergeBatches(result));
          } else {
            resolve(result ?? new Uint8Array(0));
          }
        });
      } else {
         // Fallback: Create a raw connection
         try {
            const rawConn = rawDb.connect();
            
            // Handle case where rawDb is actually the connection itself (sometimes happens in certain pool configs)
            const target = typeof rawDb.arrowIPCAll === 'function' 
              ? rawDb 
              : (rawConn && typeof rawConn.arrowIPCAll === 'function' ? rawConn : null);

            if (target) {
               // biome-ignore lint/suspicious/noExplicitAny: internal callback signature
               target.arrowIPCAll(sql, ...params, (err: any, result: any) => {
                  if (err) {
                    const msg = String(err.message || '');
                    if (msg.includes('to_arrow_ipc') || msg.includes('Table Function')) {
                      return runFallback();
                    }
                    return reject(err);
                  }
                  if (Array.isArray(result)) {
                    resolve(mergeBatches(result));
                  } else {
                    resolve(result ?? new Uint8Array(0));
                  }
               });
            } else {
               runFallback();
            }
         } catch(_e) {
            runFallback();
         }
      }
    });
  }
}