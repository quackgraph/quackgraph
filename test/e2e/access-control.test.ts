import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: RBAC (Access Control)', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should resolve nested group memberships to check permissions', async () => {
    // User -> MEMBER_OF -> Group A -> MEMBER_OF -> Group B -> HAS_PERMISSION -> Resource
    const setup = await createGraph('disk', 'e2e-rbac');
    g = setup.graph;
    path = setup.path;

    await g.addNode('user:alice', ['User']);
    await g.addNode('group:devs', ['Group']);
    await g.addNode('group:admins', ['Group']);
    await g.addNode('res:prod_db', ['Resource']);

    // Alice is in Devs
    await g.addEdge('user:alice', 'group:devs', 'MEMBER_OF');
    // Devs is a subset of Admins (Nested Group)
    await g.addEdge('group:devs', 'group:admins', 'MEMBER_OF');
    // Admins have access to Prod DB
    await g.addEdge('group:admins', 'res:prod_db', 'CAN_ACCESS');

    // Query: Can Alice access prod_db?
    
    // 1 hop check (Direct access?)
    const direct = await g.match(['User'])
        .where({ id: 'user:alice' })
        .out('CAN_ACCESS')
        .select(r => r.id);
    expect(direct).toEqual([]);

    // 2 hop check (Group access)
    const groupAccess = await g.match(['User'])
        .where({ id: 'user:alice' })
        .out('MEMBER_OF')
        .out('CAN_ACCESS')
        .select(r => r.id);
    // Alice -> Devs -x-> ? (Devs don't have direct access)
    expect(groupAccess).toEqual([]);

    // 3 hop check (Nested Group access)
    const nestedAccess = await g.match(['User'])
        .where({ id: 'user:alice' })
        .out('MEMBER_OF') // Devs
        .out('MEMBER_OF') // Admins
        .out('CAN_ACCESS') // Prod DB
        .select(r => r.id);
    
    expect(nestedAccess).toContain('res:prod_db');
  });
});