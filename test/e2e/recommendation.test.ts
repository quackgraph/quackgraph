import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: Recommendation Engine (Collaborative Filtering)', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should recommend products based on "Users who bought X also bought Y"', async () => {
    const setup = await createGraph('disk', 'e2e-recs');
    g = setup.graph;
    path = setup.path;

    // Data Setup
    // Alice bought: Phone, Headphones, Case
    // Bob bought: Phone
    // Charlie bought: Headphones
    
    // Goal: Recommend "Headphones" and "Case" to Bob because he is similar to Alice (shared Phone).
    
    await g.addNode('Alice', ['User']);
    await g.addNode('Bob', ['User']);
    await g.addNode('Charlie', ['User']);

    await g.addNode('Phone', ['Product'], { price: 800 });
    await g.addNode('Headphones', ['Product'], { price: 200 });
    await g.addNode('Case', ['Product'], { price: 50 });

    // Alice's purchases
    await g.addEdge('Alice', 'Phone', 'BOUGHT');
    await g.addEdge('Alice', 'Headphones', 'BOUGHT');
    await g.addEdge('Alice', 'Case', 'BOUGHT');

    // Bob's purchases
    await g.addEdge('Bob', 'Phone', 'BOUGHT');

    // Charlie's purchases
    await g.addEdge('Charlie', 'Headphones', 'BOUGHT');

    // Query for Bob:
    // 1. What did Bob buy? (Phone)
    // 2. Who else bought that? (Alice)
    // 3. What else did they buy? (Headphones, Case)
    
    const recs = await g.match(['User'])
      .where({ id: 'Bob' })
      .out('BOUGHT')      // -> Phone
      .in('BOUGHT')       // -> Alice, Bob
      .out('BOUGHT')      // -> Phone, Headphones, Case
      .node(['Product'])
      .select(p => p.id);

    // Result should contain products.
    // Note: It will contain 'Phone' because Alice bought it too. 
    // A real engine would filter out already purchased items.
    
    const uniqueRecs = [...new Set(recs)];
    
    expect(uniqueRecs).toContain('Headphones');
    expect(uniqueRecs).toContain('Case');
    expect(uniqueRecs).toContain('Phone');
  });

  test('should filter recommendations by property (e.g. price < 100)', async () => {
    // Re-using the graph state from previous test would be ideal if we didn't teardown.
    // But we teardown. Let's quickly rebuild a smaller version.
    
    const setup = await createGraph('disk', 'e2e-recs-filter');
    g = setup.graph;
    path = setup.path;

    await g.addNode('U1', ['User']);
    await g.addNode('U2', ['User']);
    await g.addNode('Luxury', ['Product'], { price: 1000 });
    await g.addNode('Cheap', ['Product'], { price: 20 });

    // U1 bought both
    await g.addEdge('U1', 'Luxury', 'BOUGHT');
    await g.addEdge('U1', 'Cheap', 'BOUGHT');
    
    // U2 bought Luxury
    await g.addEdge('U2', 'Luxury', 'BOUGHT');

    // Recommend to U2 based on similarity (Luxury), but only Cheap stuff
    const results = await g.match(['User'])
      .where({ id: 'U2' })
      .out('BOUGHT')    // -> Luxury
      .in('BOUGHT')     // -> U1, U2
      .out('BOUGHT')    // -> Luxury, Cheap
      .node(['Product'])
      .where({ price: 20 }) // DuckDB Filter
      .select(p => p.id);

    expect(results).toContain('Cheap');
    expect(results).not.toContain('Luxury');
  });
});