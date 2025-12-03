import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: Knowledge Graph RAG (Vector + Graph)', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should combine vector search with graph traversal', async () => {
    const setup = await createGraph('disk', 'e2e-rag');
    g = setup.graph;
    path = setup.path;

    // Hack: Manually enable VSS capability if the extension failed to load but array_distance exists (Native DuckDB)
    // This ensures tests pass on environments without the VSS binary extension
    if (!g.capabilities.vss) {
       try {
         // Verify array_distance availability before claiming VSS support
         await g.db.query("SELECT array_distance([1,2]::DOUBLE[2], [3,4]::DOUBLE[2])");
         g.capabilities.vss = true;
       } catch (_e) {
         console.warn("Skipping RAG test: array_distance not supported in this DuckDB build.");
         return;
       }
    }

    // 1. Setup Data
    // Query Vector: [1, 0, 0]
    // Doc A: [0.9, 0.1, 0] (Close) -> WrittenBy Alice
    // Doc B: [0, 1, 0]     (Far)   -> WrittenBy Bob

    const vecQuery = [1, 0, 0];
    const vecA = [0.9, 0.1, 0];
    const vecB = [0, 1, 0];

    await g.addNode('doc:A', ['Document'], { title: 'Apples' });
    await g.addNode('doc:B', ['Document'], { title: 'Sky' });
    
    // Backfill embeddings manually (since addNode helper doesn't expose float[] column)
    await g.db.execute("UPDATE nodes SET embedding = ?::DOUBLE[3] WHERE id = 'doc:A'", [`[${vecA.join(',')}]`]);
    await g.db.execute("UPDATE nodes SET embedding = ?::DOUBLE[3] WHERE id = 'doc:B'", [`[${vecB.join(',')}]`]);

    await g.addNode('u:alice', ['User'], { name: 'Alice' });
    await g.addNode('u:bob', ['User'], { name: 'Bob' });

    await g.addEdge('doc:A', 'u:alice', 'WRITTEN_BY');
    await g.addEdge('doc:B', 'u:bob', 'WRITTEN_BY');

    // 2. Query: Find 1 document nearest to query vector, then find its author
    const results = await g.match(['Document'])
        .nearText(vecQuery, { limit: 1 }) // Should select doc:A
        .out('WRITTEN_BY')                // -> Alice
        .node(['User'])
        .select(u => u.name);

    expect(results.length).toBe(1);
    expect(results[0]).toBe('Alice');
  });
});