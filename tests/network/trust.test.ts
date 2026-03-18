/**
 * Network trust and collateral tests.
 *
 * Verifies collateral placement, dispute resolution, and trust
 * signal tracking across multiple nodes.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import { CollateralSide, CollateralStatus } from '../../src/core/TrustModule.ts';
import { DisputeVote } from '../../src/core/DisputeModule.ts';
import { TestNetwork } from './TestNetwork.ts';
import { makeAggregationBlock, makeBlock, makeGenesis, makeOutput } from './helpers.ts';

Deno.test('Trust: collateral placement tracked correctly', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Target block
  const target = makeBlock('trust-target', genesis, [makeOutput(100)], 20);
  net.deliverDirect(target, 'A');

  // Collateral block (not a descendant of target)
  const collateral = makeBlock('trust-coll', genesis, [makeOutput(50)], 5);
  net.deliverDirect(collateral, 'A');

  // Place FOR collateral
  const accepted = net.getNode('A').trust.addCollateral(
    collateral.hash,
    target.hash,
    CollateralSide.For,
    [],
    100,
  );

  assert(accepted, 'Collateral should be accepted');

  const placement = net.getNode('A').trust.getPlacement(collateral.hash);
  assert(placement !== undefined, 'Placement should exist');
  assertEquals(placement!.side, CollateralSide.For);
  assertEquals(placement!.amount, 100);
  assertEquals(placement!.status, CollateralStatus.Active);
});

Deno.test('Trust: FOR and AGAINST stakes computed correctly', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const target = makeBlock('stakes-target', genesis, [makeOutput(100)], 20);
  net.deliverDirect(target, 'A');

  // Place multiple FOR and AGAINST collaterals
  const forColl1 = makeBlock('for-1', genesis, [makeOutput(10)], 1);
  const forColl2 = makeBlock('for-2', genesis, [makeOutput(10)], 2);
  const againstColl = makeBlock('against-1', genesis, [makeOutput(10)], 3);

  net.deliverDirect(forColl1, 'A');
  net.deliverDirect(forColl2, 'A');
  net.deliverDirect(againstColl, 'A');

  net.getNode('A').trust.addCollateral(forColl1.hash, target.hash, CollateralSide.For, [], 50);
  net.getNode('A').trust.addCollateral(forColl2.hash, target.hash, CollateralSide.For, [], 30);
  net.getNode('A').trust.addCollateral(
    againstColl.hash,
    target.hash,
    CollateralSide.Against,
    [],
    20,
  );

  const state = net.getNode('A').trust.getTrustState(target.hash);
  assertEquals(state.forAmount, 80); // 50 + 30
  assertEquals(state.againstAmount, 20);
  assertEquals(state.activePlacements, 3);
});

Deno.test('Trust: circular trust rejected -- collateral cannot be descendant of target', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const target = makeBlock('circ-target', genesis, [makeOutput(100)], 20);
  net.deliverDirect(target, 'A');

  // Collateral is a descendant of target (anchored to it)
  const descendant = makeBlock('circ-desc', target, [makeOutput(50)], 5);
  net.deliverDirect(descendant, 'A');

  // Should be rejected
  const accepted = net.getNode('A').trust.addCollateral(
    descendant.hash,
    target.hash,
    CollateralSide.For,
    [],
    100,
  );

  assertFalse(accepted, 'Descendant collateral should be rejected (circular trust)');
});

Deno.test('Trust: collateral redeemed after target aggregated', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Target and a sibling for aggregation
  const target = makeBlock('redeem-target', genesis, [makeOutput(100)], 10, [1]);
  const sibling = makeBlock('redeem-sib', genesis, [makeOutput(100)], 10, [2]);
  net.deliverDirect(target, 'A');
  net.deliverDirect(sibling, 'A');

  // Place collateral
  const coll = makeBlock('redeem-coll', genesis, [makeOutput(50)], 5);
  net.deliverDirect(coll, 'A');
  net.getNode('A').trust.addCollateral(coll.hash, target.hash, CollateralSide.For, [], 100);

  // Before aggregation, redemption should fail
  assertFalse(net.getNode('A').trust.redeemCollateral(coll.hash));

  // Aggregate the target (this marks it as aggregated in the store)
  const agg = makeAggregationBlock('redeem-agg', genesis, [target, sibling], {
    anchorOutputCount: 4,
    claimedIndices: [0, 1],
    aggregateOutputCounts: [1, 1],
  });
  net.deliverDirect(agg, 'A');

  // Now redemption should succeed
  const redeemed = net.getNode('A').trust.redeemCollateral(coll.hash);
  assert(redeemed, 'Collateral should be redeemable after aggregation');

  const placement = net.getNode('A').trust.getPlacement(coll.hash);
  assertEquals(placement!.status, CollateralStatus.Redeemed);
});

Deno.test('Trust: collateral reclaimed when target becomes non-canonical', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Target block and a competing block
  const target = makeBlock('reclaim-target', genesis, [makeOutput(100)], 10, [1]);
  net.deliverDirect(target, 'A');

  // Place collateral while target is canonical
  const coll = makeBlock('reclaim-coll', genesis, [makeOutput(50)], 5);
  net.deliverDirect(coll, 'A');
  net.getNode('A').trust.addCollateral(coll.hash, target.hash, CollateralSide.For, [], 100);

  assert(net.getNode('A').consensus.isCanonical(target.hash));

  // Competitor with higher weight makes target non-canonical
  const competitor = makeBlock('reclaim-comp', genesis, [makeOutput(100)], 1000, [1]);
  net.deliverDirect(competitor, 'A');

  assertFalse(net.getNode('A').consensus.isCanonical(target.hash));

  // Now reclaim should succeed
  const reclaimed = net.getNode('A').trust.reclaimCollateral(coll.hash);
  assert(reclaimed, 'Collateral should be reclaimable when target is non-canonical');

  const placement = net.getNode('A').trust.getPlacement(coll.hash);
  assertEquals(placement!.status, CollateralStatus.Reclaimed);
});

Deno.test('Trust: dispute resolution payout proportional to stake', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const target = makeBlock('dispute-target', genesis, [makeOutput(100)], 20);
  net.deliverDirect(target, 'A');

  // Multiple FOR collaterals
  const for1 = makeBlock('disp-for1', genesis, [makeOutput(10)], 1);
  const for2 = makeBlock('disp-for2', genesis, [makeOutput(10)], 2);
  net.deliverDirect(for1, 'A');
  net.deliverDirect(for2, 'A');

  net.getNode('A').trust.addCollateral(for1.hash, target.hash, CollateralSide.For, [], 60);
  net.getNode('A').trust.addCollateral(for2.hash, target.hash, CollateralSide.For, [], 40);

  // One AGAINST collateral
  const against = makeBlock('disp-against', genesis, [makeOutput(10)], 3);
  net.deliverDirect(against, 'A');
  net.getNode('A').trust.addCollateral(
    against.hash,
    target.hash,
    CollateralSide.Against,
    [],
    50,
  );

  // Resolve dispute
  const result = net.getNode('A').dispute.resolve(target.hash);

  // FOR side has 100, AGAINST has 50 -- FOR wins
  assertEquals(result.winningSide, DisputeVote.Valid);
  assertEquals(result.validStake, 100);
  assertEquals(result.invalidStake, 50);

  // Total pool is 150, distributed proportionally to FOR winners
  // for1 gets 60% of 150 = 90, for2 gets 40% of 150 = 60
  assertEquals(result.requiredOutputs.length, 2);
  const values = result.requiredOutputs.map((o) => o.value).sort((a, b) => b - a);
  assertEquals(values[0], 90); // 60/100 * 150
  assertEquals(values[1], 60); // 40/100 * 150
});
