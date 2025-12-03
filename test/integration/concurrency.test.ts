import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';

describe('Integration: Concurrency', () => {
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should handle concurrent node additions without data loss', async () => {
    const setup = await createGraph('disk', 'int-concurrency');
    const g = setup.graph;
    path = setup.path;

    const count = 100;
    const promises = [];

    // Fire 100 writes "simultaneously"
    for (let i = 0; i < count; i++) {
      promises.push(g.addNode(`node:${i}`, ['Node'], { index: i }));
    }

    await Promise.all(promises);

    expect(g.native.nodeCount).toBe(count);
    
    // Check DB persistence
    const rows = await g.db.query('SELECT count(*) as c FROM nodes WHERE valid_to IS NULL');
    const c = Number(rows[0].c); 
    expect(c).toBe(count);
  });

  test('should handle concurrent edge additions between same nodes', async () => {
    // Tests locking mechanism on adjacency list (if any) or vector resizing safety
    const setup = await createGraph('disk', 'int-concurrency-edges');
    const g = setup.graph;
    path = setup.path;

    await g.addNode('A', ['Node']);
    await g.addNode('B', ['Node']);

    const count = 50;
    const promises = [];

    // Add 50 edges "simultaneously" of DIFFERENT types to avoid idempotency masking the test
    for (let i = 0; i < count; i++) {
      promises.push(g.addEdge('A', 'B', `LINK_${i}`));
    }

    await Promise.all(promises);

    expect(g.native.edgeCount).toBe(count);

    // Verify traversal finds them all
    // Checking one specific link
    const neighbors = g.native.traverse(['A'], 'LINK_42', 'out');
    expect(neighbors).toEqual(['B']);
  });

  test('should deduplicate edges during bulk hydration (Append-Then-Sort)', async () => {
    // This tests the optimized Arrow ingestion strategy
    const setup = await createGraph('disk', 'int-bulk-dedup');
    const g = setup.graph;
    path = setup.path;

    // 1. Manually insert duplicates into DuckDB (bypassing graph API which might check)
    // QuackGraph schema: edges(source, target, type, ...)
    const sql = `
      INSERT INTO edges (source, target, type, valid_from, valid_to) VALUES 
      ('src', 'tgt', 'KNOWS', current_timestamp, NULL),
      ('src', 'tgt', 'KNOWS', current_timestamp, NULL), -- Duplicate
      ('src', 'tgt', 'KNOWS', current_timestamp, NULL)  -- Triplicate
    `;
    await g.db.execute(sql);

    // 2. Hydrate
    // Re-initialize to trigger hydration from disk
    // We use the same file path
    await g.native.loadArrowIpc(
      Buffer.from(await g.db.queryArrow("SELECT source, target, type FROM edges WHERE valid_to IS NULL"))
    );

    // 3. Compact (Triggers Sort & Dedup)
    g.native.compact();

    // 4. Verify
    // Should count as 1 edge in topology
    // Note: If we didn't compact, this might be 3 depending on implementation, but compact enforces uniqueness.
    expect(g.native.edgeCount).toBe(1);
    expect(g.native.traverse(['src'], 'KNOWS', 'out')).toEqual(['tgt']);
  });
});