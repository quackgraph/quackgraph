import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('Integration: Complex Query Logic', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should support the "Sandwich" pattern: Filter -> Traverse -> Filter', async () => {
    const setup = await createGraph('disk', 'int-complex-query');
    g = setup.graph;
    path = setup.path;

    // Graph:
    // User(Active) -> KNOWS -> User(Active, Age 20)
    // User(Active) -> KNOWS -> User(Inactive, Age 20)
    // User(Active) -> KNOWS -> User(Active, Age 50)

    await g.addNode('start', ['User'], { status: 'active' });
    
    await g.addNode('u1', ['User'], { status: 'active', age: 20 });
    await g.addNode('u2', ['User'], { status: 'inactive', age: 20 });
    await g.addNode('u3', ['User'], { status: 'active', age: 50 });

    await g.addEdge('start', 'u1', 'KNOWS');
    await g.addEdge('start', 'u2', 'KNOWS');
    await g.addEdge('start', 'u3', 'KNOWS');

    // Query: Start node (status=active) -> KNOWS -> End node (status=active AND age=20)
    const results = await g.match(['User'])
        .where({ id: 'start', status: 'active' }) // Initial Filter
        .out('KNOWS')                             // Traversal
        .node(['User'])
        .where({ status: 'active', age: 20 })     // Terminal Filter
        .select(u => u.id);

    expect(results.length).toBe(1);
    expect(results[0]).toBe('u1');
  });

  test('should handle empty intermediate results gracefully', async () => {
    const setup = await createGraph('disk', 'int-empty-query');
    g = setup.graph;
    path = setup.path;

    await g.addNode('a', ['Node']);
    
    const results = await g.match(['Node'])
        .where({ id: 'a' })
        .out('MISSING_EDGE')
        .out('ANOTHER_EDGE')
        .select(n => n.id);

    expect(results).toEqual([]);
  });
});