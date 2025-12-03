import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: Infrastructure Routing (Redundancy)', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should find alternate path after link failure', async () => {
    const setup = await createGraph('disk', 'e2e-infra');
    g = setup.graph;
    path = setup.path;

    /*
      Topology:
      Start -> Switch1 -> End
      Start -> Switch2 -> End
    */

    await g.addNode('start', ['Server']);
    await g.addNode('end', ['Server']);
    await g.addNode('sw1', ['Switch']);
    await g.addNode('sw2', ['Switch']);

    await g.addEdge('start', 'sw1', 'CONN');
    await g.addEdge('sw1', 'end', 'CONN');
    
    await g.addEdge('start', 'sw2', 'CONN');
    await g.addEdge('sw2', 'end', 'CONN');

    // 1. Verify reachability (Start -> ... -> End)
    const reach1 = await g.match(['Server'])
        .where({ id: 'start' })
        .out('CONN') // sw1, sw2
        .out('CONN') // end
        .select(n => n.id);
    
    expect(reach1).toEqual(['end']);

    // 2. Fail Switch 1 Link (Start -> Switch1)
    await g.deleteEdge('start', 'sw1', 'CONN');

    // 3. Verify reachability again
    // Should still reach 'end' via sw2
    const reach2 = await g.match(['Server'])
        .where({ id: 'start' })
        .out('CONN') // sw2 only (sw1 path dead)
        .out('CONN') // end
        .select(n => n.id);

    expect(reach2).toEqual(['end']);

    // 4. Fail Switch 2 Link
    await g.deleteEdge('start', 'sw2', 'CONN');

    // 5. Verify Isolation
    const reach3 = await g.match(['Server'])
        .where({ id: 'start' })
        .out('CONN') 
        .out('CONN') 
        .select(n => n.id);

    expect(reach3).toEqual([]);
  });
});