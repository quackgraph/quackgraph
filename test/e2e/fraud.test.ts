import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: Fraud Detection (Graph Analysis)', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should detect indirect links between users via shared resources', async () => {
    const setup = await createGraph('disk', 'e2e-fraud');
    g = setup.graph;
    path = setup.path;

    // 1. Seed Data: A Fraud Ring
    // Bad Actor 1 (A) shares a Device with (B).
    // (B) shares a Credit Card with Bad Actor 2 (C).
    // Link: A -> Device -> B -> Card -> C

    // Nodes
    await g.addNode('user:A', ['User'], { riskScore: 90 });
    await g.addNode('user:B', ['User'], { riskScore: 10 }); // Looks innocent
    await g.addNode('user:C', ['User'], { riskScore: 95 });
    
    await g.addNode('device:D1', ['Device'], { os: 'Android' });
    await g.addNode('card:C1', ['CreditCard'], { bin: 4242 });

    // Edges
    await g.addEdge('user:A', 'device:D1', 'USED_DEVICE');
    await g.addEdge('user:B', 'device:D1', 'USED_DEVICE');
    
    await g.addEdge('user:B', 'card:C1', 'USED_CARD');
    await g.addEdge('user:C', 'card:C1', 'USED_CARD');

    // 2. Query: Find all users linked to 'user:A' via any shared device or card
    // Path: Start(A) -> out(Device) -> in(Device) -> out(Card) -> in(Card) -> Result(C)
    // Note: We need to be careful with traversal steps.
    
    // Step 1: Find devices used by A
    // Step 2: Find users who used those devices (getting B)
    // Step 3: Find cards used by those users (getting C1)
    // Step 4: Find users who used those cards (getting C)
    
    const linkedUsers = await g.match(['User'])
      .where({ riskScore: 90 }) // Select A
      .out('USED_DEVICE')       // -> D1
      .in('USED_DEVICE')        // -> A, B
      .out('USED_CARD')         // -> C1 (from B)
      .in('USED_CARD')          // -> B, C
      .node(['User'])           // Filter just in case
      .select(u => u.id);

    // 3. Verify
    // Should contain C. Might contain A and B depending on cycles, which is fine for graph traversal.
    expect(linkedUsers).toContain('user:C');
    expect(linkedUsers).toContain('user:B');
  });

  test('should isolate clean users from the ring', async () => {
    // Re-use graph or create new? 'afterEach' cleans up, so we need setup again if we wanted clean state.
    // Since we destroy in afterEach, we need to setup again.
    // To speed up, we could do this in one test file with one setup, but isolation is requested.
    // For this specific test, we'll create a new isolated graph.
    
    const setup = await createGraph('disk', 'e2e-fraud-clean');
    const g2 = setup.graph;
    // We rely on afterEach to clean this path too if we update the `path` variable correctly 
    // or we can just manually clean this one. 
    // The `path` variable is scoped to describe, so we update it.
    path = setup.path; 

    await g2.addNode('good_user', ['User']);
    await g2.addNode('bad_user', ['User']);
    await g2.addNode('device:1', ['Device']);
    await g2.addNode('device:2', ['Device']); // Different device

    await g2.addEdge('good_user', 'device:1', 'USED');
    await g2.addEdge('bad_user', 'device:2', 'USED');

    const links = await g2.match(['User'])
      .where({ id: 'good_user' })
      .out('USED')
      .in('USED')
      .select(u => u.id);

    // Should only find themselves (good_user -> device:1 -> good_user)
    expect(links.length).toBe(1);
    expect(links[0]).toBe('good_user');
    expect(links).not.toContain('bad_user');
  });
});