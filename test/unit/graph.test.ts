import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('Unit: QuackGraph Core', () => {
  let g: QuackGraph;
  let path: string;

  beforeEach(async () => {
    const setup = await createGraph('memory');
    g = setup.graph;
    path = setup.path;
  });

  afterEach(async () => {
    await cleanupGraph(path);
  });

  test('should initialize with zero nodes', () => {
    expect(g.native.nodeCount).toBe(0);
    expect(g.native.edgeCount).toBe(0);
  });

  test('should add nodes and increment count', async () => {
    await g.addNode('u:1', ['User'], { name: 'Alice' });
    await g.addNode('u:2', ['User'], { name: 'Bob' });
    
    // Check Rust Index
    expect(g.native.nodeCount).toBe(2);
    
    // Check DuckDB Storage
    const rows = await g.db.query('SELECT * FROM nodes');
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.id === 'u:1').properties).toContain('Alice');
  });

  test('should add edges and support traversal', async () => {
    await g.addNode('a', ['Node']);
    await g.addNode('b', ['Node']);
    await g.addEdge('a', 'b', 'LINK');

    expect(g.native.edgeCount).toBe(1);

    // Simple manual traversal check using native directly
    const neighbors = g.native.traverse(['a'], 'LINK', 'out');
    expect(neighbors).toEqual(['b']);
  });

  test('should be idempotent when adding same edge', async () => {
    await g.addNode('a', ['Node']);
    await g.addNode('b', ['Node']);
    
    await g.addEdge('a', 'b', 'LINK');
    await g.addEdge('a', 'b', 'LINK'); // Duplicate

    expect(g.native.edgeCount).toBe(1);
    const neighbors = g.native.traverse(['a'], 'LINK', 'out');
    expect(neighbors).toEqual(['b']);
  });

  test('should soft delete nodes and stop traversal', async () => {
    await g.addNode('a', ['Node']);
    await g.addNode('b', ['Node']);
    await g.addEdge('a', 'b', 'LINK');

    let neighbors = g.native.traverse(['a'], 'LINK', 'out');
    expect(neighbors).toEqual(['b']);

    await g.deleteNode('b');

    // Rust index should treat it as tombstoned
    neighbors = g.native.traverse(['a'], 'LINK', 'out');
    expect(neighbors).toEqual([]);

    // Check DB soft delete
    const rows = await g.db.query("SELECT * FROM nodes WHERE id = 'b' AND valid_to IS NOT NULL");
    expect(rows.length).toBe(1);
  });
});