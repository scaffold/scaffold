/**
 * Network aggregation tests.
 *
 * Verifies aggregation block behavior across multi-node networks:
 * subtree rollup, weight vectors, claim mask merging, and
 * coordinator-driven aggregation.
 */

import { assert, assertEquals } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import { getBlockWeightVector } from '../../src/core/Block.ts';
import { TestNetwork } from './TestNetwork.ts';
import { makeAggregationBlock, makeBlock, makeGenesis, makeOutput } from './helpers.ts';

Deno.test('Aggregation: aggregation block accepted on all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Two non-conflicting subtrees
  const sub1 = makeBlock('agg-sub1', genesis, [makeOutput(100)], 10, [1]);
  const sub2 = makeBlock('agg-sub2', genesis, [makeOutput(200)], 15, [2]);

  net.deliverToAll(sub1, 'A');
  net.deliverToAll(sub2, 'B');

  // Aggregation block rolls them up
  const agg = makeAggregationBlock('agg-block', genesis, [sub1, sub2], {
    anchorOutputCount: 4,
    claimedIndices: [0, 1], // subtree claims on anchor outputs 0 and 1
    aggregateOutputCounts: [1, 1], // each subtree produces 1 output
  });

  net.deliverToAll(agg, 'A');

  net.assertAllHave(agg.hash);
  net.assertAllCanonical(agg.hash);
  net.assertAllAgree();
});

Deno.test('Aggregation: weight vector consistent across nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const sub1 = makeBlock('wv-sub1', genesis, [makeOutput(100)], 10, [1]);
  const sub2 = makeBlock('wv-sub2', genesis, [makeOutput(200)], 15, [2]);

  net.deliverToAll(sub1, 'A');
  net.deliverToAll(sub2, 'B');

  const agg = makeAggregationBlock('wv-agg', genesis, [sub1, sub2], {
    anchorOutputCount: 4,
    claimedIndices: [0, 1],
    aggregateOutputCounts: [1, 1],
    declaredWeight: 5,
  });

  net.deliverToAll(agg, 'A');

  // Weight vector: [5 + 25] = [30] (declaredWeight + sum of subtree weights)
  for (const id of net.nodeIds) {
    const block = net.getNode(id).store.get(agg.hash);
    assert(block !== undefined, `Node ${id} should have agg block`);
    const wv = getBlockWeightVector(block);
    assertEquals(wv, [30], `Node ${id} weight vector mismatch`);
  }
});

Deno.test('Aggregation: non-conflicting subtrees can be aggregated', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(6);
  net.broadcastGenesis(genesis);

  // Three subtrees, each claiming a different output
  const sub1 = makeBlock('nc-sub1', genesis, [makeOutput(100)], 10, [1]);
  const sub2 = makeBlock('nc-sub2', genesis, [makeOutput(100)], 10, [2]);
  const sub3 = makeBlock('nc-sub3', genesis, [makeOutput(100)], 10, [3]);

  net.deliverDirect(sub1, 'A');
  net.deliverDirect(sub2, 'A');
  net.deliverDirect(sub3, 'A');

  // All three should be canonical (no conflicts)
  assert(net.getNode('A').consensus.isCanonical(sub1.hash));
  assert(net.getNode('A').consensus.isCanonical(sub2.hash));
  assert(net.getNode('A').consensus.isCanonical(sub3.hash));

  // Aggregate all three
  const agg = makeAggregationBlock('nc-agg', genesis, [sub1, sub2, sub3], {
    anchorOutputCount: 6,
    claimedIndices: [0, 1, 2],
    aggregateOutputCounts: [1, 1, 1],
  });

  net.deliverDirect(agg, 'A');
  assert(net.getNode('A').consensus.isCanonical(agg.hash));
});

Deno.test('Aggregation: subtrees marked as aggregated on all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const sub1 = makeBlock('mark-sub1', genesis, [makeOutput(100)], 10, [1]);
  const sub2 = makeBlock('mark-sub2', genesis, [makeOutput(200)], 15, [2]);

  net.deliverToAll(sub1, 'A');
  net.deliverToAll(sub2, 'B');

  const agg = makeAggregationBlock('mark-agg', genesis, [sub1, sub2], {
    anchorOutputCount: 4,
    claimedIndices: [0, 1],
    aggregateOutputCounts: [1, 1],
  });

  net.deliverToAll(agg, 'A');

  // Subtrees should be marked as aggregated on all nodes
  for (const id of net.nodeIds) {
    const store = net.getNode(id).store;
    assert(store.isAggregated(sub1.hash), `Node ${id}: sub1 should be aggregated`);
    assert(store.isAggregated(sub2.hash), `Node ${id}: sub2 should be aggregated`);
  }
});

Deno.test('Aggregation: aggregation block with claim mask merging', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B']) net.addNode(id);

  const genesis = makeGenesis(6);
  net.broadcastGenesis(genesis);

  // Subtree 1 claims outputs 0 and 1
  const sub1 = makeBlock('cm-sub1', genesis, [makeOutput(100), makeOutput(100)], 10, [2, 3]);

  // Subtree 2 claims output 2
  const sub2 = makeBlock('cm-sub2', genesis, [makeOutput(100)], 15, [3]);

  net.deliverToAll(sub1, 'A');
  net.deliverToAll(sub2, 'B');

  // Aggregation: merged claim mask covers outputs 0, 1, 2
  const agg = makeAggregationBlock('cm-agg', genesis, [sub1, sub2], {
    anchorOutputCount: 6,
    claimedIndices: [0, 1, 2],
    aggregateOutputCounts: [2, 1],
  });

  net.deliverToAll(agg, 'A');

  net.assertAllHave(agg.hash);
  net.assertAllCanonical(agg.hash);
  net.assertAllAgree();
});
