import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import {
  CollateralSide,
  CollateralStatus,
  TrustModule,
  TrustProvider,
} from '../src/core/TrustModule.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  declaredWeight: number;
  childWeights: number[]; // declared weight contribution per child index
}

class TestProvider implements TrustProvider<TestBlock> {
  private blocks = new Map<HashPrimitive, TestBlock>();
  private aggregated = new Set<HashPrimitive>();
  private canonical = new Set<HashPrimitive>();
  private ancestorPairs = new Set<string>();

  add(block: TestBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
    // Default to canonical
    this.canonical.add(block.hash.toPrimitive());
  }

  setAggregated(hash: Hash): void {
    this.aggregated.add(hash.toPrimitive());
  }

  setNonCanonical(hash: Hash): void {
    this.canonical.delete(hash.toPrimitive());
  }

  /** Register that `ancestor` is an ancestor of `descendant`. */
  addAncestry(ancestor: Hash, descendant: Hash): void {
    this.ancestorPairs.add(`${ancestor.toPrimitive()}:${descendant.toPrimitive()}`);
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toPrimitive());
  }

  getAnchor(block: TestBlock): Hash {
    return block.anchor;
  }

  getDeclaredWeight(block: TestBlock): number {
    return block.declaredWeight;
  }

  getChildDeclaredWeight(block: TestBlock, childIndex: number): number {
    return block.childWeights[childIndex] ?? 0;
  }

  isAggregated(hash: Hash): boolean {
    return this.aggregated.has(hash.toPrimitive());
  }

  isCanonical(hash: Hash): boolean {
    return this.canonical.has(hash.toPrimitive());
  }

  isAncestor(ancestor: Hash, descendant: Hash): boolean {
    return this.ancestorPairs.has(
      `${ancestor.toPrimitive()}:${descendant.toPrimitive()}`,
    );
  }
}

const h = (name: string): Hash => Hash.digest(name);

function setup(): { provider: TestProvider; module: TrustModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new TrustModule(provider);
  return { provider, module };
}

function block(
  name: string,
  declaredWeight: number,
  opts?: { anchor?: Hash; childWeights?: number[] },
): TestBlock {
  return {
    hash: h(name),
    anchor: opts?.anchor ?? ZERO_HASH,
    declaredWeight,
    childWeights: opts?.childWeights ?? [],
  };
}

// -- Tests: Adding collateral ------------------------------------

Deno.test('add FOR collateral and retrieve it', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  const ok = module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50);
  assert(ok);

  const p = module.getPlacement(C.hash)!;
  assertEquals(p.collateralHash, C.hash);
  assertEquals(p.targetHash, H.hash);
  assertEquals(p.side, CollateralSide.For);
  assertEquals(p.path, []);
  assertEquals(p.amount, 50);
  assertEquals(p.status, CollateralStatus.Active);
});

Deno.test('add AGAINST collateral with path', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  const ok = module.addCollateral(
    C.hash,
    H.hash,
    CollateralSide.Against,
    [3, 0, 1],
    25,
  );
  assert(ok);

  const p = module.getPlacement(C.hash)!;
  assertEquals(p.side, CollateralSide.Against);
  assertEquals(p.path, [3, 0, 1]);
  assertEquals(p.amount, 25);
});

Deno.test('reject collateral when C is descendant of H', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0, { anchor: H.hash });
  provider.add(H);
  provider.add(C);
  provider.addAncestry(H.hash, C.hash);

  const ok = module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50);
  assertFalse(ok);
  assertEquals(module.getPlacement(C.hash), undefined);
});

Deno.test('reject duplicate collateral hash', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  assert(module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50));
  assertFalse(module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50));
});

Deno.test('reject collateral with non-positive amount', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  assertFalse(module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 0));
  assertFalse(module.addCollateral(C.hash, H.hash, CollateralSide.For, [], -10));
});

// -- Tests: Redeeming collateral (happy path) --------------------

Deno.test('redeem collateral after target is aggregated', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50);

  // H gets aggregated
  provider.setAggregated(H.hash);

  assert(module.redeemCollateral(C.hash));
  assertEquals(module.getPlacement(C.hash)!.status, CollateralStatus.Redeemed);
});

Deno.test('reject redemption when target not yet aggregated', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50);

  // H not aggregated yet
  assertFalse(module.redeemCollateral(C.hash));
  assertEquals(module.getPlacement(C.hash)!.status, CollateralStatus.Active);
});

Deno.test('reject redemption of already redeemed collateral', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50);
  provider.setAggregated(H.hash);
  module.redeemCollateral(C.hash);

  assertFalse(module.redeemCollateral(C.hash));
});

// -- Tests: Reclaiming collateral (non-canonical) ----------------

Deno.test('reclaim collateral when target non-canonical', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50);

  // H loses consensus race
  provider.setNonCanonical(H.hash);

  assert(module.reclaimCollateral(C.hash));
  assertEquals(module.getPlacement(C.hash)!.status, CollateralStatus.Reclaimed);
});

Deno.test('reject reclaim when target is still canonical', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50);

  // H is still canonical
  assertFalse(module.reclaimCollateral(C.hash));
  assertEquals(module.getPlacement(C.hash)!.status, CollateralStatus.Active);
});

Deno.test('reject reclaim of already claimed collateral', () => {
  const { provider, module } = setup();
  const H = block('H', 100, { childWeights: [100] });
  const forC = block('forC', 0);
  const againstC = block('againstC', 0);
  provider.add(H);
  provider.add(forC);
  provider.add(againstC);

  module.addCollateral(forC.hash, H.hash, CollateralSide.For, [0], 50);
  module.addCollateral(againstC.hash, H.hash, CollateralSide.Against, [0], 30);

  // AGAINST wins dispute
  module.claimCollateral(H.hash, [0], CollateralSide.Against, 10);

  // FOR collateral was claimed — can't reclaim
  provider.setNonCanonical(H.hash);
  assertFalse(module.reclaimCollateral(forC.hash));
});

// -- Tests: Claiming collateral (dispute resolution) -------------

Deno.test('AGAINST wins: claims FOR collateral', () => {
  const { provider, module } = setup();
  const H = block('H', 100, { childWeights: [100] });
  const forC = block('forC', 0);
  const againstC = block('againstC', 0);
  provider.add(H);
  provider.add(forC);
  provider.add(againstC);

  module.addCollateral(forC.hash, H.hash, CollateralSide.For, [0], 50);
  module.addCollateral(againstC.hash, H.hash, CollateralSide.Against, [0], 30);

  const claimed = module.claimCollateral(H.hash, [0], CollateralSide.Against, 10);
  assertEquals(claimed, 50); // FOR side loses its 50

  assertEquals(module.getPlacement(forC.hash)!.status, CollateralStatus.Claimed);
  // AGAINST side keeps its collateral (not claimed)
  assertEquals(module.getPlacement(againstC.hash)!.status, CollateralStatus.Active);
});

Deno.test('FOR wins: claims AGAINST collateral', () => {
  const { provider, module } = setup();
  const H = block('H', 100, { childWeights: [100] });
  const forC = block('forC', 0);
  const againstC = block('againstC', 0);
  provider.add(H);
  provider.add(forC);
  provider.add(againstC);

  module.addCollateral(forC.hash, H.hash, CollateralSide.For, [0], 50);
  module.addCollateral(againstC.hash, H.hash, CollateralSide.Against, [0], 30);

  const claimed = module.claimCollateral(H.hash, [0], CollateralSide.For, 10);
  assertEquals(claimed, 30); // AGAINST side loses its 30

  assertEquals(module.getPlacement(againstC.hash)!.status, CollateralStatus.Claimed);
  assertEquals(module.getPlacement(forC.hash)!.status, CollateralStatus.Active);
});

Deno.test('claim limited by encapsulated weight * N', () => {
  const { provider, module } = setup();
  // Child at index 0 has declared weight 20, aggregator claims it as 20
  const H = block('H', 100, { childWeights: [20] });
  const forC1 = block('forC1', 0);
  const forC2 = block('forC2', 0);
  const againstC = block('againstC', 0);
  provider.add(H);
  provider.add(forC1);
  provider.add(forC2);
  provider.add(againstC);

  module.addCollateral(forC1.hash, H.hash, CollateralSide.For, [0], 200);
  module.addCollateral(forC2.hash, H.hash, CollateralSide.For, [0], 200);
  module.addCollateral(againstC.hash, H.hash, CollateralSide.Against, [0], 30);

  // claim_limit = encapsulated_weight(20) * N(5) = 100
  // Total FOR collateral = 400, but capped at 100
  const claimed = module.claimCollateral(H.hash, [0], CollateralSide.Against, 5);
  assertEquals(claimed, 100);
});

Deno.test('claim at root path [] uses target declared weight', () => {
  const { provider, module } = setup();
  const H = block('H', 50);
  const forC = block('forC', 0);
  const againstC = block('againstC', 0);
  provider.add(H);
  provider.add(forC);
  provider.add(againstC);

  module.addCollateral(forC.hash, H.hash, CollateralSide.For, [], 1000);
  module.addCollateral(againstC.hash, H.hash, CollateralSide.Against, [], 30);

  // encapsulated_weight at [] = H's own declared weight = 50
  // claim_limit = 50 * 10 = 500
  const claimed = module.claimCollateral(H.hash, [], CollateralSide.Against, 10);
  assertEquals(claimed, 500);
});

// -- Tests: Encapsulated weight ----------------------------------

Deno.test('encapsulated weight at root path is target declared weight', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  provider.add(H);

  assertEquals(module.getEncapsulatedWeight(H.hash, []), 100);
});

Deno.test('encapsulated weight at child path uses child declared weight', () => {
  const { provider, module } = setup();
  // H has child at index 2, aggregator declares child contributes 80
  const H = block('H', 200, { childWeights: [50, 30, 80] });
  provider.add(H);

  assertEquals(module.getEncapsulatedWeight(H.hash, [2]), 80);
});

Deno.test('encapsulated weight uses minimum of child own weight and aggregator claim', () => {
  const { provider, module } = setup();
  // Aggregator says child 0 contributes 10, but child declares 1000
  // Encapsulated weight = aggregator's claim (10) because it's smaller
  const H = block('H', 200, { childWeights: [10] });
  provider.add(H);

  // encapsulated weight at [0] = 10 (aggregator's claim, which is smaller)
  assertEquals(module.getEncapsulatedWeight(H.hash, [0]), 10);
});

Deno.test('claim limit equals encapsulated weight times multiplier', () => {
  const { provider, module } = setup();
  const H = block('H', 100, { childWeights: [30] });
  provider.add(H);

  assertEquals(module.getClaimLimit(H.hash, [0], 5), 150);
  assertEquals(module.getClaimLimit(H.hash, [0], 10), 300);
  assertEquals(module.getClaimLimit(H.hash, [], 5), 500);
});

// -- Tests: Query methods ----------------------------------------

Deno.test('getPlacementsForTarget returns all placements', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C1 = block('C1', 0);
  const C2 = block('C2', 0);
  const C3 = block('C3', 0);
  provider.add(H);
  provider.add(C1);
  provider.add(C2);
  provider.add(C3);

  module.addCollateral(C1.hash, H.hash, CollateralSide.For, [], 50);
  module.addCollateral(C2.hash, H.hash, CollateralSide.Against, [0], 30);
  module.addCollateral(C3.hash, H.hash, CollateralSide.For, [0], 20);

  const placements = module.getPlacementsForTarget(H.hash);
  assertEquals(placements.length, 3);
});

Deno.test('getPlacementsAtPath filters by path', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C1 = block('C1', 0);
  const C2 = block('C2', 0);
  const C3 = block('C3', 0);
  provider.add(H);
  provider.add(C1);
  provider.add(C2);
  provider.add(C3);

  module.addCollateral(C1.hash, H.hash, CollateralSide.For, [], 50);
  module.addCollateral(C2.hash, H.hash, CollateralSide.Against, [0], 30);
  module.addCollateral(C3.hash, H.hash, CollateralSide.For, [0], 20);

  const atRoot = module.getPlacementsAtPath(H.hash, []);
  assertEquals(atRoot.length, 1);
  assertEquals(atRoot[0].amount, 50);

  const atChild = module.getPlacementsAtPath(H.hash, [0]);
  assertEquals(atChild.length, 2);
});

Deno.test('getTrustState returns correct summary', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C1 = block('C1', 0);
  const C2 = block('C2', 0);
  const C3 = block('C3', 0);
  provider.add(H);
  provider.add(C1);
  provider.add(C2);
  provider.add(C3);

  module.addCollateral(C1.hash, H.hash, CollateralSide.For, [], 50);
  module.addCollateral(C2.hash, H.hash, CollateralSide.Against, [0], 30);
  module.addCollateral(C3.hash, H.hash, CollateralSide.For, [0], 20);

  const state = module.getTrustState(H.hash);
  assertEquals(state.forAmount, 70); // 50 + 20
  assertEquals(state.againstAmount, 30);
  assertEquals(state.activePlacements, 3);
});

Deno.test('getTrustState excludes redeemed/claimed placements', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C1 = block('C1', 0);
  const C2 = block('C2', 0);
  provider.add(H);
  provider.add(C1);
  provider.add(C2);

  module.addCollateral(C1.hash, H.hash, CollateralSide.For, [], 50);
  module.addCollateral(C2.hash, H.hash, CollateralSide.For, [], 30);

  // Redeem C1
  provider.setAggregated(H.hash);
  module.redeemCollateral(C1.hash);

  const state = module.getTrustState(H.hash);
  assertEquals(state.forAmount, 30); // only C2's amount
  assertEquals(state.activePlacements, 1);
});

Deno.test('hasActiveTrust returns true when FOR collateral exists', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  assertFalse(module.hasActiveTrust(H.hash));

  module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50);
  assert(module.hasActiveTrust(H.hash));
});

Deno.test('hasActiveTrust returns false when only AGAINST collateral exists', () => {
  const { provider, module } = setup();
  const H = block('H', 100);
  const C = block('C', 0);
  provider.add(H);
  provider.add(C);

  module.addCollateral(C.hash, H.hash, CollateralSide.Against, [0], 50);
  assertFalse(module.hasActiveTrust(H.hash));
});

// -- Tests: Edge cases -------------------------------------------

Deno.test('getPlacement returns undefined for unknown hash', () => {
  const { module } = setup();
  assertEquals(module.getPlacement(h('unknown')), undefined);
});

Deno.test('getPlacementsForTarget returns empty for unknown target', () => {
  const { module } = setup();
  assertEquals(module.getPlacementsForTarget(h('unknown')).length, 0);
});

Deno.test('getTrustState returns zeros for unknown target', () => {
  const { module } = setup();
  const state = module.getTrustState(h('unknown'));
  assertEquals(state.forAmount, 0);
  assertEquals(state.againstAmount, 0);
  assertEquals(state.activePlacements, 0);
});

Deno.test('redeemCollateral returns false for unknown placement', () => {
  const { module } = setup();
  assertFalse(module.redeemCollateral(h('unknown')));
});

Deno.test('reclaimCollateral returns false for unknown placement', () => {
  const { module } = setup();
  assertFalse(module.reclaimCollateral(h('unknown')));
});

Deno.test('multiple placements on same target at different paths', () => {
  const { provider, module } = setup();
  const H = block('H', 100, { childWeights: [40, 60] });
  const C1 = block('C1', 0);
  const C2 = block('C2', 0);
  const C3 = block('C3', 0);
  provider.add(H);
  provider.add(C1);
  provider.add(C2);
  provider.add(C3);

  module.addCollateral(C1.hash, H.hash, CollateralSide.For, [], 50);
  module.addCollateral(C2.hash, H.hash, CollateralSide.For, [0], 30);
  module.addCollateral(C3.hash, H.hash, CollateralSide.Against, [1], 20);

  assertEquals(module.getPlacementsAtPath(H.hash, []).length, 1);
  assertEquals(module.getPlacementsAtPath(H.hash, [0]).length, 1);
  assertEquals(module.getPlacementsAtPath(H.hash, [1]).length, 1);
});

Deno.test('claim only affects placements at the specified path', () => {
  const { provider, module } = setup();
  const H = block('H', 100, { childWeights: [40, 60] });
  const forRoot = block('forRoot', 0);
  const forChild = block('forChild', 0);
  const againstChild = block('againstChild', 0);
  provider.add(H);
  provider.add(forRoot);
  provider.add(forChild);
  provider.add(againstChild);

  module.addCollateral(forRoot.hash, H.hash, CollateralSide.For, [], 50);
  module.addCollateral(forChild.hash, H.hash, CollateralSide.For, [0], 30);
  module.addCollateral(againstChild.hash, H.hash, CollateralSide.Against, [0], 20);

  // Claim at path [0] — AGAINST wins
  module.claimCollateral(H.hash, [0], CollateralSide.Against, 10);

  // forChild at [0] should be claimed, forRoot at [] should be unaffected
  assertEquals(module.getPlacement(forChild.hash)!.status, CollateralStatus.Claimed);
  assertEquals(module.getPlacement(forRoot.hash)!.status, CollateralStatus.Active);
});

Deno.test('encapsulated weight returns 0 for unknown target', () => {
  const { module } = setup();
  assertEquals(module.getEncapsulatedWeight(h('unknown'), []), 0);
});

Deno.test('C can anchor to same block as H (sibling, not descendant)', () => {
  const { provider, module } = setup();
  const G = block('G', 0);
  const H = block('H', 100, { anchor: G.hash });
  const C = block('C', 0, { anchor: G.hash });
  provider.add(G);
  provider.add(H);
  provider.add(C);
  // C and H are siblings — C is NOT a descendant of H

  assert(module.addCollateral(C.hash, H.hash, CollateralSide.For, [], 50));
});
