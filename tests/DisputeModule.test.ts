import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { CollateralPlacement, CollateralSide, CollateralStatus } from '../src/core/TrustModule.ts';
import { SIGNATURE_CONTRACT } from '../src/core/Block.ts';
import { DisputeModule, DisputeProvider, DisputeVote } from '../src/core/DisputeModule.ts';

// -- Test helpers ----------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

class MockDisputeProvider implements DisputeProvider {
  readonly placements: CollateralPlacement[] = [];

  addPlacement(
    collateralName: string,
    targetHash: Hash,
    side: CollateralSide,
    amount: number,
  ): void {
    this.placements.push({
      collateralHash: h(collateralName),
      targetHash,
      side,
      path: [],
      amount,
      status: CollateralStatus.Active,
    });
  }

  getCollateralPlacements(targetHash: Hash): CollateralPlacement[] {
    return this.placements.filter(
      (p) => p.targetHash.toHex() === targetHash.toHex(),
    );
  }

  getValidStake(targetHash: Hash): number {
    return this.getCollateralPlacements(targetHash)
      .filter((p) => p.side === CollateralSide.For && p.status === CollateralStatus.Active)
      .reduce((sum, p) => sum + p.amount, 0);
  }

  getInvalidStake(targetHash: Hash): number {
    return this.getCollateralPlacements(targetHash)
      .filter((p) => p.side === CollateralSide.Against && p.status === CollateralStatus.Active)
      .reduce((sum, p) => sum + p.amount, 0);
  }
}

function setup() {
  const provider = new MockDisputeProvider();
  const module = new DisputeModule(provider);
  return { provider, module };
}

// -- Tests -----------------------------------------------------------

Deno.test('DisputeModule: majority VALID wins', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  provider.addPlacement('valid-1', target, CollateralSide.For, 100);
  provider.addPlacement('valid-2', target, CollateralSide.For, 50);
  provider.addPlacement('invalid-1', target, CollateralSide.Against, 30);

  const result = module.resolve(target);

  assertEquals(result.winningSide, DisputeVote.Valid);
  assertEquals(result.validStake, 150);
  assertEquals(result.invalidStake, 30);
});

Deno.test('DisputeModule: majority INVALID wins', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  provider.addPlacement('valid-1', target, CollateralSide.For, 30);
  provider.addPlacement('invalid-1', target, CollateralSide.Against, 100);
  provider.addPlacement('invalid-2', target, CollateralSide.Against, 50);

  const result = module.resolve(target);

  assertEquals(result.winningSide, DisputeVote.Invalid);
  assertEquals(result.validStake, 30);
  assertEquals(result.invalidStake, 150);
});

Deno.test('DisputeModule: tie goes to VALID', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  provider.addPlacement('valid-1', target, CollateralSide.For, 100);
  provider.addPlacement('invalid-1', target, CollateralSide.Against, 100);

  const result = module.resolve(target);

  assertEquals(result.winningSide, DisputeVote.Valid);
});

Deno.test('DisputeModule: payout computation — proportional shares', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  // VALID side wins with 150 total, INVALID has 50. Total pool = 200.
  provider.addPlacement('valid-1', target, CollateralSide.For, 100);
  provider.addPlacement('valid-2', target, CollateralSide.For, 50);
  provider.addPlacement('invalid-1', target, CollateralSide.Against, 50);

  const result = module.resolve(target);

  assertEquals(result.winningSide, DisputeVote.Valid);
  assertEquals(result.requiredOutputs.length, 2);

  // Total pool = 200, valid-1 has 100/150, valid-2 has 50/150
  const totalOutputValue = result.requiredOutputs.reduce((sum, o) => sum + o.value, 0);
  // Total output should equal total pool (200)
  assertEquals(Math.round(totalOutputValue), 200);

  // Check proportional shares
  const share1 = result.requiredOutputs[0].value;
  const share2 = result.requiredOutputs[1].value;
  // valid-1 (100/150 * 200 ≈ 133.33), valid-2 (50/150 * 200 ≈ 66.67)
  assert(Math.abs(share1 - (100 / 150) * 200) < 0.01);
  assert(Math.abs(share2 - (50 / 150) * 200) < 0.01);
});

Deno.test('DisputeModule: required outputs sum to total collateral', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  provider.addPlacement('v1', target, CollateralSide.For, 75);
  provider.addPlacement('v2', target, CollateralSide.For, 25);
  provider.addPlacement('i1', target, CollateralSide.Against, 50);

  const result = module.resolve(target);

  const totalOutputValue = result.requiredOutputs.reduce((sum, o) => sum + o.value, 0);
  const totalCollateral = 75 + 25 + 50;
  assertEquals(Math.round(totalOutputValue), totalCollateral);
});

Deno.test('DisputeModule: payout outputs use SIGNATURE_CONTRACT', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  provider.addPlacement('valid-1', target, CollateralSide.For, 100);
  provider.addPlacement('invalid-1', target, CollateralSide.Against, 50);

  const result = module.resolve(target);

  for (const output of result.requiredOutputs) {
    assert(Hash.equals(output.verifier.contract, SIGNATURE_CONTRACT));
  }
});

Deno.test('DisputeModule: no collateral → VALID wins, no outputs', () => {
  const { module } = setup();

  const target = h('empty-target');
  const result = module.resolve(target);

  assertEquals(result.winningSide, DisputeVote.Valid);
  assertEquals(result.validStake, 0);
  assertEquals(result.invalidStake, 0);
  assertEquals(result.requiredOutputs.length, 0);
});

Deno.test('DisputeModule: INVALID winners get payout when INVALID wins', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  provider.addPlacement('valid-1', target, CollateralSide.For, 30);
  provider.addPlacement('invalid-1', target, CollateralSide.Against, 70);
  provider.addPlacement('invalid-2', target, CollateralSide.Against, 30);

  const result = module.resolve(target);

  assertEquals(result.winningSide, DisputeVote.Invalid);
  assertEquals(result.requiredOutputs.length, 2);

  // Total pool = 130, invalid-1 has 70/100, invalid-2 has 30/100
  const totalOutputValue = result.requiredOutputs.reduce((sum, o) => sum + o.value, 0);
  assertEquals(Math.round(totalOutputValue), 130);
});

Deno.test('DisputeModule: buildResolutionSpec creates valid spec', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  const anchor = h('anchor-block');
  provider.addPlacement('v1', target, CollateralSide.For, 100);
  provider.addPlacement('i1', target, CollateralSide.Against, 50);

  const spec = module.buildResolutionSpec(target, anchor);

  assertEquals(spec.anchor.toHex(), anchor.toHex());
  assert(spec.outputs.length > 0);
  assertEquals(spec.claims.length, 0);
  assertEquals(spec.declaredWeight, 1);
  assertEquals(spec.aggregates.length, 0);
  assertEquals(spec.refs.length, 1);
  assertEquals(spec.refs[0].toHex(), target.toHex());
});

Deno.test('DisputeModule: single voter gets entire pool', () => {
  const { provider, module } = setup();

  const target = h('target-block');
  provider.addPlacement('valid-1', target, CollateralSide.For, 100);

  const result = module.resolve(target);

  assertEquals(result.winningSide, DisputeVote.Valid);
  assertEquals(result.requiredOutputs.length, 1);
  assertEquals(result.requiredOutputs[0].value, 100);
});
