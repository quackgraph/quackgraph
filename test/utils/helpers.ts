import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuackGraph } from '../../packages/quack-graph/src/index';

export const getTempPath = (prefix = 'quack-test') => {
  const uuid = crypto.randomUUID();
  return join(tmpdir(), `${prefix}-${uuid}.duckdb`);
};

export const createGraph = async (mode: 'memory' | 'disk' = 'memory', dbName?: string) => {
  const path = mode === 'memory' ? ':memory:' : getTempPath(dbName);
  const graph = new QuackGraph(path);
  await graph.init();
  return { graph, path };
};

export const cleanupGraph = async (path: string) => {
  if (path === ':memory:') return;
  try {
    // Aggressively clean up main DB file and potential WAL/tmp files
    await unlink(path).catch(() => {});
    await unlink(`${path}.wal`).catch(() => {});
    await unlink(`${path}.tmp`).catch(() => {});
    // Snapshots are sometimes saved as .bin
    await unlink(`${path}.bin`).catch(() => {});
  } catch (_e) {
    // Ignore errors if file doesn't exist
  }
};

/**
 * Wait for a short duration. Useful if we need to ensure timestamps differ slightly
 * (though QuackGraph uses microsecond precision usually, node might be ms).
 */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Seeds a basic graph with a few nodes and edges for testing traversals.
 * A -> B -> C
 *      |
 *      v
 *      D
 */
export const seedBasicGraph = async (g: QuackGraph) => {
  await g.addNode('a', ['Node']);
  await g.addNode('b', ['Node']);
  await g.addNode('c', ['Node']);
  await g.addNode('d', ['Node']);
  await g.addEdge('a', 'b', 'NEXT');
  await g.addEdge('b', 'c', 'NEXT');
  await g.addEdge('b', 'd', 'NEXT');
};