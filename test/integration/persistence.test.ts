import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import { QuackGraph } from '../../packages/quack-graph/src/index';

describe('Integration: Persistence & Hydration', () => {
  // Keep track of paths to clean up
  const paths: string[] = [];

  afterEach(async () => {
    for (const p of paths) {
      await cleanupGraph(p);
    }
    paths.length = 0; // Clear
  });

  test('should hydrate Rust topology from Disk on startup', async () => {
    // 1. Setup Graph A (Disk)
    const setup = await createGraph('disk', 'persist-hydrate');
    const g1 = setup.graph;
    const path = setup.path;
    paths.push(path);

    // 2. Add Data to Graph A
    await g1.addNode('root', ['Root']);
    await g1.addNode('child1', ['Leaf']);
    await g1.addNode('child2', ['Leaf']);
    await g1.addEdge('root', 'child1', 'PARENT_OF');
    await g1.addEdge('root', 'child2', 'PARENT_OF');

    expect(g1.native.nodeCount).toBe(3);
    expect(g1.native.edgeCount).toBe(2);

    // 3. Initialize Graph B on the same file (Simulates Restart)
    const g2 = new QuackGraph(path);
    await g2.init(); // Triggers hydrate() from Arrow IPC

    // 4. Verify Graph B State
    expect(g2.native.nodeCount).toBe(3);
    expect(g2.native.edgeCount).toBe(2);

    const children = g2.native.traverse(['root'], 'PARENT_OF', 'out');
    expect(children.length).toBe(2);
    expect(children.sort()).toEqual(['child1', 'child2']);
  });

  test('should respect soft deletes during hydration', async () => {
    const setup = await createGraph('disk', 'persist-soft-del');
    const g1 = setup.graph;
    paths.push(setup.path);

    await g1.addNode('a', ['A']);
    await g1.addNode('b', ['B']);
    await g1.addEdge('a', 'b', 'KNOWS');

    // Soft Delete
    await g1.deleteEdge('a', 'b', 'KNOWS');
    
    // Verify immediate effect in Memory
    expect(g1.native.traverse(['a'], 'KNOWS', 'out')).toEqual([]);

    // Restart / Hydrate
    const g2 = new QuackGraph(setup.path);
    await g2.init();

    // Verify Deleted Edge is NOT hydrated
    // The edge is loaded into the temporal index, but should not be active.
    // The raw edge count will include historical edges.
    expect(g2.native.edgeCount).toBe(1);
    const neighbors = g2.native.traverse(['a'], 'KNOWS', 'out');
    expect(neighbors).toEqual([]);
  });

  test('Snapshot: should save and load binary topology', async () => {
    const setup = await createGraph('disk', 'persist-snapshot');
    const g1 = setup.graph;
    paths.push(setup.path);
    const snapshotPath = `${setup.path}.bin`;
    paths.push(snapshotPath); // Cleanup this too

    // Populate
    await g1.addNode('x', ['X']);
    await g1.addNode('y', ['Y']);
    await g1.addEdge('x', 'y', 'LINK');

    // Save Snapshot
    g1.optimize.saveTopologySnapshot(snapshotPath);

    // Load New Graph using Snapshot (skipping DB hydration)
    const g2 = new QuackGraph(setup.path, { topologySnapshot: snapshotPath });
    await g2.init();

    expect(g2.native.nodeCount).toBe(2);
    expect(g2.native.edgeCount).toBe(1);
    expect(g2.native.traverse(['x'], 'LINK', 'out')).toEqual(['y']);
  });

  test('Special Characters: should handle emojis and spaces in IDs', async () => {
    const setup = await createGraph('disk', 'persist-special');
    const g1 = setup.graph;
    paths.push(setup.path);

    const id1 = 'User A (Admin)';
    const id2 = 'User B 🦆';

    await g1.addNode(id1, ['User']);
    await g1.addNode(id2, ['User']);
    await g1.addEdge(id1, id2, 'EMOJI_LINK 🔗');

    // Restart
    const g2 = new QuackGraph(setup.path);
    await g2.init();

    const result = g2.native.traverse([id1], 'EMOJI_LINK 🔗', 'out');
    expect(result).toEqual([id2]);
    
    // Reverse
    const reverse = g2.native.traverse([id2], 'EMOJI_LINK 🔗', 'in');
    expect(reverse).toEqual([id1]);
  });
});