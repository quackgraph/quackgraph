import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: Identity Resolution', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should link disjoint user entities via shared attributes', async () => {
    const setup = await createGraph('disk', 'e2e-identity');
    g = setup.graph;
    path = setup.path;

    // Scenario: User Login vs Anonymous Cookie
    // User1 (Cookie ID) -> Device A
    // User2 (Login ID)  -> Device A
    
    await g.addNode('cookie:123', ['Cookie']);
    await g.addNode('user:alice', ['User']);
    await g.addNode('device:iphone', ['Device']);

    await g.addEdge('cookie:123', 'device:iphone', 'USED_ON');
    await g.addEdge('user:alice', 'device:iphone', 'USED_ON');

    // Find all identities linked to cookie:123
    // Path: Cookie -> USED_ON -> Device -> (in) USED_ON -> User
    
    const identities = await g.match(['Cookie'])
      .where({ id: 'cookie:123' })
      .out('USED_ON') // -> Device
      .in('USED_ON')  // -> Cookie, User
      .select(n => n.id);
      
    expect(identities).toContain('user:alice');
    expect(identities).toContain('cookie:123'); // Should contain self
    expect(identities.length).toBe(2);
  });

  test('should handle cycles gracefully during traversal', async () => {
    const setup = await createGraph('disk', 'e2e-identity-cycle');
    g = setup.graph;
    path = setup.path;
    
    // A -> B -> A
    await g.addNode('A', ['Node']);
    await g.addNode('B', ['Node']);
    await g.addEdge('A', 'B', 'LINK');
    await g.addEdge('B', 'A', 'LINK');

    // Traverse A -> out -> out -> out
    // Rust topology traversal handles cycles by purely following edges step-by-step
    // It does not maintain "visited" state across steps, only within a single step (dedup).
    
    const res = await g.match(['Node'])
        .where({ id: 'A' })
        .out('LINK') // -> B
        .out('LINK') // -> A
        .out('LINK') // -> B
        .select(n => n.id);
        
    expect(res).toEqual(['B']);
  });
});