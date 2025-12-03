import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph, sleep } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('Integration: Temporal Time-Travel', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should retrieve historical property values using asOf', async () => {
    const setup = await createGraph('disk', 'temporal-props');
    g = setup.graph;
    path = setup.path;

    // T0: Create
    await g.addNode('u1', ['User'], { status: 'active' });
    const t0 = new Date();
    await sleep(100); // Ensure clock tick

    // T1: Update
    await g.addNode('u1', ['User'], { status: 'suspended' });
    const t1 = new Date();
    await sleep(100);

    // T2: Update again
    await g.addNode('u1', ['User'], { status: 'banned' });
    const _t2 = new Date();

    // Query Current (T2)
    const current = await g.match(['User']).where({}).select();
    expect(current[0].status).toBe('banned');

    // Query T0 (Should see 'active')
    // Note: strict equality might be tricky with microsecond precision,
    // so we pass a time slightly after T0 or exactly T0.
    // The query logic is: valid_from <= T AND (valid_to > T OR valid_to IS NULL)
    // At T0: valid_from=T0, valid_to=T1.
    // Query at T0: T0 <= T0 (True) AND T1 > T0 (True).
    const q0 = await g.asOf(t0).match(['User']).where({}).select();
    expect(q0[0].status).toBe('active');

    // Query T1 (Should see 'suspended')
    const q1 = await g.asOf(t1).match(['User']).where({}).select();
    expect(q1[0].status).toBe('suspended');
  });

  test('should handle node lifecycle (create -> delete)', async () => {
    const setup = await createGraph('disk', 'temporal-lifecycle');
    g = setup.graph;
    path = setup.path;

    // T0: Empty
    const t0 = new Date();
    await sleep(50);

    // T1: Alive
    await g.addNode('temp', ['Temp']);
    const t1 = new Date();
    await sleep(50);

    // T2: Deleted
    await g.deleteNode('temp');
    const t2 = new Date();

    // Verify
    const resT0 = await g.asOf(t0).match(['Temp']).select();
    expect(resT0.length).toBe(0);

    const resT1 = await g.asOf(t1).match(['Temp']).select();
    expect(resT1.length).toBe(1);
    expect(resT1[0].id).toBe('temp');

    const resT2 = await g.asOf(t2).match(['Temp']).select();
    expect(resT2.length).toBe(0);
  });

  test('should traverse historical topology (Structural Time-Travel)', async () => {
    // Scenario:
    // T0: A -> B
    // T1: Delete A -> B
    // T2: Create A -> C
    // Query at T0: Returns B
    // Query at T2: Returns C

    const setup = await createGraph('disk', 'temporal-topology');
    g = setup.graph;
    path = setup.path;

    await g.addNode('A', ['Node']);
    await g.addNode('B', ['Node']);
    await g.addNode('C', ['Node']);

    // T0: Create Edge
    await g.addEdge('A', 'B', 'LINK');
    await sleep(50);
    const t0 = new Date();
    await sleep(50);

    // T1: Delete Edge
    await g.deleteEdge('A', 'B', 'LINK');
    await sleep(50);

    // T2: Create New Edge
    await g.addEdge('A', 'C', 'LINK');
    await sleep(50);
    const t2 = new Date();

    // To test historical topology, we must re-hydrate from disk to ensure we have the
    // complete temporal edge data, as the live instance's memory might have been
    // modified by hard-deletes (removeEdge).
    const g2 = new QuackGraph(path);
    await g2.init();

    // Check T0 (Historical)
    const resT0 = await g2.asOf(t0).match(['Node']).where({ id: 'A' }).out('LINK').select(n => n.id);
    expect(resT0).toEqual(['B']);

    // Check T2 (Current)
    const resT2 = await g2.asOf(t2).match(['Node']).where({ id: 'A' }).out('LINK').select(n => n.id);
    expect(resT2).toEqual(['C']);
  });
});