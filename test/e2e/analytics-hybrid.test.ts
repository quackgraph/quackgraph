import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: Hybrid Analytics (Graph + SQL)', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should compute SQL aggregations (AVG, STDDEV) on graph traversal results', async () => {
    const setup = await createGraph('disk', 'e2e-analytics');
    g = setup.graph;
    path = setup.path;

    // 1. Generate Data: 1 Category -> 100 Products with deterministic prices
    const productCount = 100;
    await g.addNode('cat:electronics', ['Category']);

    // Generate price distribution: 50, 60, 70...
    for (let i = 0; i < productCount; i++) {
      const price = (i * 10) + 50; 
      const pid = `prod:${i}`;
      await g.addNode(pid, ['Product'], { price });
      await g.addEdge('cat:electronics', pid, 'HAS_PRODUCT');
    }

    // 2. Traversal: Get IDs of all products in 'electronics'
    const products = await g.match(['Category'])
        .where({ id: 'cat:electronics' })
        .out('HAS_PRODUCT')
        .node(['Product'])
        .select(p => p.id);
    
    expect(products.length).toBe(productCount);

    // 3. Analytics: Compute stats on the filtered subset using raw SQL
    // This proves we can leverage DuckDB's columnar engine on graph results
    const placeholders = products.map(() => '?').join(',');
    const sql = `
      SELECT 
        avg((properties->>'price')::FLOAT) as avg_price,
        stddev((properties->>'price')::FLOAT) as std_price,
        quantile_cont((properties->>'price')::FLOAT, 0.95) as p95_price
      FROM nodes 
      WHERE id IN (${placeholders})
    `;
    
    const stats = await g.db.query(sql, products);
    const row = stats[0];

    // Expected AVG: 50 + (99*10)/2 = 545
    const expectedAvg = 50 + ((productCount - 1) * 10) / 2;

    expect(Number(row.avg_price)).toBe(expectedAvg);
    expect(Number(row.std_price)).toBeGreaterThan(0);
    expect(Number(row.p95_price)).toBeGreaterThan(Number(row.avg_price));
  });
});