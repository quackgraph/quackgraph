import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('Integration: Error Handling & Edge Cases', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should allow edges to non-existent nodes (Graph Pattern Matching behavior)', async () => {
    // QuackGraph V1 is schemaless. It allows adding edges to nodes that haven't been explicitly created.
    // However, since those nodes don't exist in the 'nodes' table, they should be filtered out 
    // during the final hydration (SELECT * FROM nodes) step of the query builder.
    
    const setup = await createGraph('disk', 'int-errors');
    g = setup.graph;
    path = setup.path;

    await g.addNode('real_node', ['Node']);
    // Edge to phantom node
    await g.addEdge('real_node', 'phantom_node', 'LINK');

    // 1. Native Traversal should find it (Topology exists)
    const nativeNeighbors = g.native.traverse(['real_node'], 'LINK', 'out');
    expect(nativeNeighbors).toContain('phantom_node');

    // 2. Query Builder should NOT return it (Data missing)
    const neighbors = await g.match(['Node'])
        .where({ id: 'real_node' })
        .out('LINK')
        .select(n => n.id);

    expect(neighbors.length).toBe(0); 
  });

  test('should handle special characters in IDs', async () => {
    const setup = await createGraph('disk', 'int-special-chars');
    g = setup.graph;
    path = setup.path;

    const crazyId = 'Node/With"Quotes\'And\\Backslashes 🦆';
    await g.addNode(crazyId, ['Node']);
    await g.addNode('b', ['Node']);
    await g.addEdge(crazyId, 'b', 'LINK');

    const result = await g.match(['Node'])
        .where({ id: crazyId })
        .out('LINK')
        .select(n => n.id);
        
    expect(result).toEqual(['b']);
    
    // Reverse check
    const reverse = await g.match(['Node'])
        .where({ id: 'b' })
        .in('LINK')
        .select(n => n.id);
    
    expect(reverse).toEqual([crazyId]);
  });
});