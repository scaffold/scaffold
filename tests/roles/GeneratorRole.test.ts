import { assertEquals } from '@std/assert';
import { AGGREGATION_CONTRACT } from '../../src/contract/static/Aggregation.ts';
import { Context } from '../../src/Context.ts';
import { BlockStore } from '../../src/graph/BlockStore.ts';
import { DraftStore } from '../../src/graph/DraftStore.ts';
import { AtomSource, Block, OutputResolverType } from '../../src/graph/types.ts';
import { GeneratorRole, GeneratorRoleConfig } from '../../src/roles/GeneratorRole.ts';
import { neverAbort } from '../../src/util/abortable.ts';
import { Hash } from '../../src/util/Hash.ts';
import { makeTestContext } from '../helpers/v2.ts';

// A generator resumes from `await env.claim()` on a microtask and builds once the
// contract returns, so a block claimed during ingestion appears a turn later.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  ctx: Context;
  built: Block[];
  publish(): Block;
}

function harness(): Harness {
  const ctx = makeTestContext();

  // Every test here is about aggregating, which a node skips by default.
  ctx.configure(GeneratorRoleConfig, { skipAggregation: false });

  // Genesis first, so the aggregation generator is the only one running -- the role
  // backfills nothing, and genesis' signature outputs would otherwise spawn their own.
  ctx.get(BlockStore).ingest({
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw: ctx.config.genesis,
  });

  const built: Block[] = [];
  ctx.get(BlockStore).onIngest((block) => built.push(block), neverAbort);
  ctx.get(GeneratorRole);

  // An empty draft still carries the aggregation output `DraftStore` mints for it (wp 7).
  const publish = (): Block => {
    ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
    return built[built.length - 1];
  };

  return { ctx, built, publish };
}

const aggregationOutputIndex = (block: Block): number =>
  block.payload.outputs.findIndex((x) => Hash.equals(x.contract, AGGREGATION_CONTRACT));

Deno.test('a published block carries an aggregation output nothing has claimed yet', async () => {
  const h = harness();
  const first = h.publish();
  await settle();

  assertEquals(h.built.length, 1);
  assertEquals(aggregationOutputIndex(first), 0);
  assertEquals(first.payload.claims, []);
});

Deno.test('one block is not enough to aggregate', async () => {
  const h = harness();
  h.publish();
  await settle();

  // The generator has claimed the first output and is parked on its second `claim()`.
  assertEquals(h.built.length, 1);
});

Deno.test('two published blocks are aggregated into a third', async () => {
  const h = harness();
  const first = h.publish();
  await settle();
  const second = h.publish();
  await settle();

  assertEquals(h.built.length, 3);
  const aggregation = h.built[2];
  assertEquals(
    aggregation.payload.aggregates.map((x) => x.block.toHex()).sort(),
    [first.hash.toHex(), second.hash.toHex()].sort(),
  );
  assertEquals(aggregation.payload.claims.length, 2);
});

Deno.test('both aggregation outputs are claimed by the one aggregation block', async () => {
  const h = harness();
  const first = h.publish();
  await settle();
  const second = h.publish();
  await settle();

  // The bug this pins: whoever claims an incoming output must be the generator already
  // waiting on it, not a second one the role spawns. Two generators each take one output,
  // both park on their second `claim()`, and no aggregation block is ever built.
  for (const producer of [first, second]) {
    const claims = producer.resolvingOutputs.get(BigInt(aggregationOutputIndex(producer))) ?? [];
    assertEquals(claims.length, 1);
    assertEquals(claims[0].type, OutputResolverType.Claim);
  }
});

Deno.test('the aggregation block carries an aggregation output of its own', async () => {
  const h = harness();
  h.publish();
  await settle();
  h.publish();
  await settle();

  const aggregation = h.built[2];
  assertEquals(aggregationOutputIndex(aggregation), 0);
  assertEquals(aggregation.payload.outputs.length, 1);
});

// BUG: two blocks ingested in the same synchronous turn spawn two generators.
// `GenerationEnv.claim` holds no subscription between the moment one claim resolves and
// the moment the contract's `await` continuation runs, so a generator that is logically
// waiting is invisible to `OutputIndex` for that window. `GeneratorRole.trigger` sees an
// unclaimed output and starts a second generator. Expected: the waiting generator takes
// the second output and builds the aggregation block, exactly as when the two blocks
// arrive in separate turns. Actual: two generators take one output each, both park on
// their second `claim()`, and no aggregation block is ever built.
Deno.test.ignore('two blocks published in one turn are aggregated into a third', async () => {
  const h = harness();
  h.publish();
  h.publish();
  await settle();

  assertEquals(h.built.length, 3);
});
