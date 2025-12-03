import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: Social Network', () => {
  let g: QuackGraph;
  let path: string;

  beforeEach(async () => {
    // We use disk to ensure full stack is exercised, though memory works too
    const setup = await createGraph('disk');
    g = setup.graph;
    path = setup.path;

    // Seed Data
    // Alice -> Bob -> Charlie
    // Alice (30), Bob (25), Charlie (20)
    await g.addNode('alice', ['User'], { name: 'Alice', age: 30, city: 'NY' });
    await g.addNode('bob', ['User'], { name: 'Bob', age: 25, city: 'SF' });
    await g.addNode('charlie', ['User'], { name: 'Charlie', age: 20, city: 'NY' });
    await g.addNode('dave', ['User'], { name: 'Dave', age: 40, city: 'NY' });

    await g.addEdge('alice', 'bob', 'KNOWS', { since: 2020 });
    await g.addEdge('bob', 'charlie', 'KNOWS', { since: 2022 });
    await g.addEdge('alice', 'dave', 'KNOWS', { since: 2010 });
  });

  afterEach(async () => {
    await cleanupGraph(path);
  });

  test('Query: Filter -> Traversal -> Select', async () => {
    // Find Users named Alice, see who they know
    const results = await g.match(['User'])
      .where({ name: 'Alice' })
      .out('KNOWS')
      .node(['User'])
      .select(u => u.name);
    
    // Alice knows Bob and Dave
    expect(results.length).toBe(2);
    expect(results.sort()).toEqual(['Bob', 'Dave']);
  });

  test('Query: Filter -> Traversal -> Filter (Sandwich)', async () => {
    // Find Users named Alice, find who they know that is UNDER 30
    // This requires DuckDB post-filter
    // Alice knows Bob (25) and Dave (40). Should only return Bob.
    
    // Note: The current fluent API in 'query.ts' supports basic where()
    // For V1 simple object matching, we can match { age: 25 } but not { age: < 30 } easily without helper
    // Let's test exact match for now as per current implementation, 
    // or rely on the query builder logic to pass raw values.
    
    const results = await g.match(['User'])
      .where({ name: 'Alice' })
      .out('KNOWS')
      .node(['User'])
      .where({ age: 25 }) // Filter for Bob
      .select(u => u.name);

    expect(results).toEqual(['Bob']);
  });

  test('Optimization: Property Promotion', async () => {
    // Promote 'age' to a native column (INTEGER)
    // This is an async schema change
    await g.optimize.promoteProperty('User', 'age', 'INTEGER');

    // Run the same query again to ensure it still works (transparent to user)
    // The query builder generates `json_extract(properties, '$.age')` which works even if column exists,
    // or DuckDB handles the ambiguity. 
    // Ideally, the query builder should be smart enough to use the column, but for now we test stability.
    
    const results = await g.match(['User'])
      .where({ name: 'Charlie' })
      .select(u => u.age);

    expect(results[0]).toBe(20);
    
    // Verify column exists in schema
    const tableInfo = await g.db.query("PRAGMA table_info('nodes')");
    const hasAge = tableInfo.some(c => c.name === 'age' && c.type === 'INTEGER');
    expect(hasAge).toBe(true);
  });
});