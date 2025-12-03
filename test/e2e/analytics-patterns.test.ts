import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: V2.1 Patterns & Analytics', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should find structural patterns (Triangle) using Rust Solver', async () => {
    const setup = await createGraph('disk', 'e2e-patterns');
    g = setup.graph;
    path = setup.path;

    // Topology: A -> B -> C -> A (Cycle)
    await g.addNode('A', ['Node']);
    await g.addNode('B', ['Node']);
    await g.addNode('C', ['Node']);
    await g.addEdge('A', 'B', 'NEXT');
    await g.addEdge('B', 'C', 'NEXT');
    await g.addEdge('C', 'A', 'NEXT');

    // Pattern: (0)-[:NEXT]->(1)-[:NEXT]->(2)-[:NEXT]->(0)
    // Variable 0 is seeded with 'A'
    const matches = g.native.matchPattern(['A'], [
      { srcVar: 0, tgtVar: 1, edgeType: 'NEXT' },
      { srcVar: 1, tgtVar: 2, edgeType: 'NEXT' },
      { srcVar: 2, tgtVar: 0, edgeType: 'NEXT' }
    ]);

    // Should find exactly one match: [A, B, C]
    expect(matches.length).toBe(1);
    expect(matches[0]).toEqual(['A', 'B', 'C']);
  });

  test('should push aggregations to DuckDB (Group By, Count, Sum)', async () => {
    const setup = await createGraph('disk', 'e2e-analytics-builder');
    g = setup.graph;
    path = setup.path;

    // Data: 10 Red items (val=1), 5 Blue items (val=10)
    for(let i=0; i<10; i++) await g.addNode(`r:${i}`, ['Item'], { color: 'red', val: 1 });
    for(let i=0; i<5; i++) await g.addNode(`b:${i}`, ['Item'], { color: 'blue', val: 10 });

    // Query: Group by color, count(*), sum(val)
    // We use DuckDB's json_extract because we haven't promoted properties to columns in this test.
    const colorExpr = "json_extract(properties, '$.color')";
    
    const results = await g.match(['Item'])
      .groupBy(colorExpr)
      .orderBy('cnt', 'DESC') // Sort by the alias 'cnt' we define below
      .select(`${colorExpr} as color, count(*) as cnt, sum(cast(json_extract(properties, '$.val') as int)) as total`);

    expect(results.length).toBe(2);
    
    // Validate Red Group (Should be first due to DESC sort on count 10 vs 5)
    // Note: DuckDB JSON extraction might return stringified values depending on casting
    const first = results[0];
    const firstColor = JSON.parse(first.color);
    
    expect(firstColor).toBe('red');
    expect(Number(first.cnt)).toBe(10);
    expect(Number(first.total)).toBe(10); // 10 * 1

    // Validate Blue Group
    const second = results[1];
    const secondColor = JSON.parse(second.color);

    expect(secondColor).toBe('blue');
    expect(Number(second.cnt)).toBe(5);
    expect(Number(second.total)).toBe(50); // 5 * 10
  });
});