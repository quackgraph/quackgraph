import { describe, test, expect, afterEach } from 'bun:test';
import { createGraph, cleanupGraph } from '../utils/helpers';
import type { QuackGraph } from '../../packages/quack-graph/src/index';

describe('E2E: Supply Chain Impact Analysis', () => {
  let g: QuackGraph;
  let path: string;

  afterEach(async () => {
    if (path) await cleanupGraph(path);
  });

  test('should identify all finished goods affected by a defective raw material', async () => {
    // Scenario:
    // Raw Material (Lithium) -> Component (Battery) -> Sub-Assembly (PowerPack) -> Product (EV Car)
    //                                               -> Product (PowerWall)
    // Raw Material (Steel)   -> Component (Chassis) -> Product (EV Car)
    
    const setup = await createGraph('disk', 'e2e-supply-chain');
    g = setup.graph;
    path = setup.path;

    // 1. Ingest Data
    await g.addNode('mat:lithium', ['Material'], { batch: 'BATCH-001' });
    await g.addNode('mat:steel', ['Material']);
    
    await g.addNode('comp:battery', ['Component']);
    await g.addNode('comp:chassis', ['Component']);
    
    await g.addNode('sub:powerpack', ['SubAssembly']);
    
    await g.addNode('prod:car', ['Product']);
    await g.addNode('prod:wall', ['Product']);

    // Flows
    await g.addEdge('mat:lithium', 'comp:battery', 'PART_OF');
    await g.addEdge('comp:battery', 'sub:powerpack', 'PART_OF');
    await g.addEdge('sub:powerpack', 'prod:car', 'PART_OF');
    await g.addEdge('sub:powerpack', 'prod:wall', 'PART_OF');
    
    await g.addEdge('mat:steel', 'comp:chassis', 'PART_OF');
    await g.addEdge('comp:chassis', 'prod:car', 'PART_OF');

    // 2. Query: The 'Lithium' batch is bad. Find all Products.
    
    // Depth 1: Battery
    const depth1 = await g.match(['Material'])
        .where({ id: 'mat:lithium' })
        .out('PART_OF')
        .select(n => n.id);
    expect(depth1).toContain('comp:battery');

    // Depth 2: Powerpack
    const depth2 = await g.match(['Material'])
        .where({ id: 'mat:lithium' })
        .out('PART_OF')
        .out('PART_OF')
        .select(n => n.id);
    expect(depth2).toContain('sub:powerpack');

    // Depth 3: Products (Car, Wall)
    const affectedProducts = await g.match(['Material'])
        .where({ id: 'mat:lithium' })
        .out('PART_OF') // Battery
        .out('PART_OF') // Powerpack
        .out('PART_OF') // Car, Wall
        .node(['Product'])
        .select(n => n.id);

    expect(affectedProducts.length).toBe(2);
    expect(affectedProducts).toContain('prod:car');
    expect(affectedProducts).toContain('prod:wall');
    
    // Ensure Steel path didn't contaminate results (Steel -> Chassis -> Car)
    // Our path started at Lithium, so it shouldn't pick up Chassis unless connected.
    
    const steelProducts = await g.match(['Material'])
        .where({ id: 'mat:steel' })
        .out('PART_OF') // Chassis
        .out('PART_OF') // Car
        .node(['Product'])
        .select(n => n.id);
        
    expect(steelProducts).toEqual(['prod:car']);
    expect(steelProducts).not.toContain('prod:wall');
  });
});