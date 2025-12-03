import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: V2 Features (Recursion & Merge)', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should traverse variable length paths (recursion)', async () => {
    const setup = await createGraph('disk', 'e2e-recursion');
    g = setup.graph;
    path = setup.path;

    // Chain: A -> B -> C -> D -> E
    await g.addNode('A', ['Node']);
    await g.addNode('B', ['Node']);
    await g.addNode('C', ['Node']);
    await g.addNode('D', ['Node']);
    await g.addNode('E', ['Node']);

    await g.addEdge('A', 'B', 'NEXT');
    await g.addEdge('B', 'C', 'NEXT');
    await g.addEdge('C', 'D', 'NEXT');
    await g.addEdge('D', 'E', 'NEXT');

    // Query 1: 1..2 hops from A
    // Should find B (1 hop) and C (2 hops)
    const result1 = await g.match(['Node'])
      .where({ id: 'A' })
      .out('NEXT').depth(1, 2)
      .select(n => n.id);
    
    expect(result1.sort()).toEqual(['B', 'C']);

    // Query 2: 2..4 hops from A
    // Should find C (2), D (3), E (4)
    const result2 = await g.match(['Node'])
      .where({ id: 'A' })
      .out('NEXT').depth(2, 4)
      .select(n => n.id);
    
    expect(result2.sort()).toEqual(['C', 'D', 'E']);

    // Query 3: Max depth exceeding chain
    const result3 = await g.match(['Node'])
      .where({ id: 'A' })
      .out('NEXT').depth(1, 10)
      .select(n => n.id);
    
    expect(result3.sort()).toEqual(['B', 'C', 'D', 'E']);
  });

  test('should handle cycles in recursive traversal gracefully', async () => {
    const setup = await createGraph('disk', 'e2e-recursion-cycle');
    g = setup.graph;
    path = setup.path;

    // Cycle: A -> B -> A
    await g.addNode('A', ['Node']);
    await g.addNode('B', ['Node']);
    await g.addEdge('A', 'B', 'LOOP');
    await g.addEdge('B', 'A', 'LOOP');

    // Recursive traverse
    // Rust implementation marks start node as visited, so it shouldn't be returned unless it's encountered again via a longer path (but BFS with visited set prevents re-visiting).
    const res = await g.match(['Node'])
      .where({ id: 'A' })
      .out('LOOP').depth(1, 5)
      .select(n => n.id);
      
    // A -> B (visited=A,B) -> A (skip)
    expect(res).toEqual(['B']);
  });

  test('should handle merge (upsert) idempotently', async () => {
    const setup = await createGraph('disk', 'e2e-merge');
    g = setup.graph;
    path = setup.path;

    // 1. First Merge (Create)
    // Matches if label='User' AND email='test@example.com'
    const id1 = await g.mergeNode('User', { email: 'test@example.com' }, { name: 'Test User', loginCount: 1 });
    
    // Check in-memory index
    const count1 = g.native.nodeCount;
    expect(count1).toBe(1);
    
    // Check DB
    const node1 = await g.match(['User']).where({ email: 'test@example.com' }).select();
    expect(node1[0].name).toBe('Test User');
    expect(node1[0].loginCount).toBe(1);

    // 2. Second Merge (Update)
    // Matches by email, updates loginCount
    const id2 = await g.mergeNode('User', { email: 'test@example.com' }, { loginCount: 2 });
    
    // ID should be same
    expect(id2).toBe(id1);
    
    // Count should remain 1
    const count2 = g.native.nodeCount;
    expect(count2).toBe(1); 

    // Properties should be merged
    const node2 = await g.match(['User']).where({ email: 'test@example.com' }).select();
    expect(node2[0].loginCount).toBe(2);
    expect(node2[0].name).toBe('Test User'); // Should persist
  });

  test('should throw error when depth is used without traversal', async () => {
    const setup = await createGraph('memory');
    g = setup.graph;

    const query = () => g.match(['Node']).depth(1, 2);
    expect(query).toThrow('depth() must be called after a traversal step');
  });
});