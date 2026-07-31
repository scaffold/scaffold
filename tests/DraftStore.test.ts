import { assertEquals, assertThrows } from '@std/assert';
import { Context } from '../src/Context.ts';
import { AtomSerializerService } from '../src/core/AtomSerializer.ts';
import { BlockStore } from '../src/core/BlockStore.ts';
import { DraftStore } from '../src/core/DraftStore.ts';
import {
  AtomSource,
  AtomType,
  Block,
  BlockPayload,
  Draft,
  DRAFT_SELF,
  DraftPayload,
  DraftStatusType,
  Output,
} from '../src/core/types.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { makeTestContext } from './helpers/v2.ts';

const out = (amount: bigint): Output => ({
  contract: ZERO_HASH,
  params: new Uint8Array(),
  amount,
});

const blockPayload = (attrs: Partial<BlockPayload> = {}): BlockPayload => ({
  anchor: ZERO_HASH,
  chain: [],
  aggregates: [],
  claims: [],
  refs: [],
  outputs: [],
  timestampMs: 0,
  ...attrs,
});

const serialize = (ctx: Context, payload: BlockPayload): Uint8Array =>
  ctx.get(AtomSerializerService).serialize(AtomType.Block, payload);

const ingest = (ctx: Context, raw: Uint8Array): Block =>
  ctx.get(BlockStore).ingest({ source: AtomSource.Local, receivedAt: 0, raw });

const ingestGenesis = (ctx: Context): Block =>
  ctx.get(BlockStore).ingest({
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw: ctx.config.genesis,
  });

interface DraftStoreInternals {
  selectReadyFunds(amount: bigint): Draft[];
  mergeDrafts(drafts: DraftPayload[]): DraftPayload;
}

const internals = (store: DraftStore) => store as unknown as DraftStoreInternals;

const surplus = (draft: Draft) => -draft.ioDelta;

const totalSurplus = (drafts: Draft[]) => drafts.reduce((acc, d) => acc + surplus(d), 0n);

const compareBigints = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;

const builtBlock = (draft: Draft): Block => {
  if (draft.status.type !== DraftStatusType.Built) {
    throw new Error(`draft is ${DraftStatusType[draft.status.type]}, not built`);
  }
  return draft.status.block;
};

// A draft holding `amounts.length` claims on a purpose-built source block, so its
// ioDelta is exactly -sum(amounts).
const fundingDraft = (store: DraftStore, source: Block, index: number): Draft =>
  store.create({ claims: [{ producer: source, outputIndex: BigInt(index) }] });

const sourceBlock = (ctx: Context, amounts: bigint[]): Block =>
  ingest(ctx, serialize(ctx, blockPayload({ outputs: amounts.map(out) })));

Deno.test('a new draft starts populating and empty', () => {
  const ctx = makeTestContext();
  const draft = ctx.get(DraftStore).create();

  assertEquals(draft.status.type, DraftStatusType.Populating);
  assertEquals(draft.claims, []);
  assertEquals(draft.refs, []);
  assertEquals(draft.outputs, []);
  assertEquals(draft.ioDelta, 0n);
});

Deno.test('create applies partial attributes', () => {
  const ctx = makeTestContext();
  const outputs = [out(5n)];
  const draft = ctx.get(DraftStore).create({ outputs });

  assertEquals(draft.outputs, outputs);
  assertEquals(draft.claims, []);
  assertEquals(draft.ioDelta, 5n);
});

Deno.test('the io delta is outputs minus claimed amounts', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [1_000n]);

  const spending = ctx.get(DraftStore).create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [out(400n)],
  });
  assertEquals(spending.ioDelta, -600n);

  const needing = ctx.get(DraftStore).create({ outputs: [out(400n)] });
  assertEquals(needing.ioDelta, 400n);

  const balanced = ctx.get(DraftStore).create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [out(1_000n)],
  });
  assertEquals(balanced.ioDelta, 0n);
});

Deno.test('the io delta ignores DRAFT_SELF claims', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [1_000n]);

  const draft = ctx.get(DraftStore).create({
    claims: [
      { producer: source, outputIndex: 0n },
      { producer: DRAFT_SELF, outputIndex: 0n },
    ],
    outputs: [out(1_000n), out(1_000n)],
  });

  assertEquals(draft.ioDelta, 0n);
});

Deno.test('update is rejected once the draft is locked', () => {
  const ctx = makeTestContext();
  const store = ctx.get(DraftStore);
  const draft = store.create();
  store.lock(draft);

  assertEquals(draft.status.type, DraftStatusType.Ready);
  assertThrows(() => store.update(draft, { claims: [], refs: [], outputs: [out(1n)] }));
});

Deno.test('lock is rejected twice', () => {
  const ctx = makeTestContext();
  const store = ctx.get(DraftStore);
  const draft = store.create();
  store.lock(draft);

  assertThrows(() => store.lock(draft));
});

Deno.test('a draft builds from populating and reaches built', () => {
  const ctx = makeTestContext();
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({
    claims: [{ producer: genesis, outputIndex: 0n }],
    outputs: [out(1_000_000n)],
  });
  store.build(draft);

  const block = builtBlock(draft);
  assertEquals(block.payload.anchor, genesis.hash);
  assertEquals(block.payload.outputs, [out(1_000_000n)]);
  assertEquals(block.claims[0].producer, genesis);
  assertEquals(block.claims[0].outputIdx, 0n);
});

Deno.test('a draft builds from ready', () => {
  const ctx = makeTestContext();
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({
    claims: [{ producer: genesis, outputIndex: 0n }],
    outputs: [out(1_000_000n)],
  });
  store.lock(draft);
  store.build(draft);

  assertEquals(draft.status.type, DraftStatusType.Built);
});

Deno.test('update and build are rejected once the draft is built', () => {
  const ctx = makeTestContext();
  ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({ outputs: [out(1n)] });
  store.build(draft);
  assertEquals(draft.status.type, DraftStatusType.Built);

  assertThrows(() => store.update(draft, { claims: [], refs: [], outputs: [] }));
  assertThrows(() => store.build(draft));
});

Deno.test('cancel moves a populating draft to cancelled and blocks building', () => {
  const ctx = makeTestContext();
  ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({ outputs: [out(1n)] });
  store.cancel(draft);

  assertEquals(draft.status.type, DraftStatusType.Cancelled);
  assertThrows(() => store.build(draft));
});

Deno.test('onBuilt fires with the built block', () => {
  const ctx = makeTestContext();
  ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const seen: (Block | undefined)[] = [];
  const draft = store.create({ outputs: [out(1n)] });
  store.onBuilt(draft, (block) => seen.push(block));
  store.build(draft);

  assertEquals(seen, [builtBlock(draft)]);
});

Deno.test('onBuilt fires immediately for an already built draft', () => {
  const ctx = makeTestContext();
  ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({ outputs: [out(1n)] });
  store.build(draft);

  const seen: (Block | undefined)[] = [];
  store.onBuilt(draft, (block) => seen.push(block));

  assertEquals(seen, [builtBlock(draft)]);
});

Deno.test('onBuilt ignores an already aborted signal', () => {
  const ctx = makeTestContext();
  ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const seen: (Block | undefined)[] = [];
  const draft = store.create({ outputs: [out(1n)] });
  const hooks = new AbortController();
  hooks.abort();
  store.onBuilt(draft, (block) => seen.push(block), hooks.signal);
  store.build(draft);

  assertEquals(seen, []);
});

Deno.test('onBuilt unsubscribes when its signal aborts', () => {
  const ctx = makeTestContext();
  ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const seen: (Block | undefined)[] = [];
  const draft = store.create({ outputs: [out(1n)] });
  const hooks = new AbortController();
  store.onBuilt(draft, (block) => seen.push(block), hooks.signal);
  hooks.abort();
  store.build(draft);

  assertEquals(seen, []);
});

// A block whose anchor is not in the store has a broken anchor chain, so nothing
// can reach the output this draft claims and placement stalls.
const stallingSetup = (ctx: Context) => {
  ingestGenesis(ctx);
  const anchorRaw = serialize(ctx, blockPayload({ outputs: [out(0n)] }));
  const orphan = ingest(
    ctx,
    serialize(
      ctx,
      blockPayload({ anchor: Hash.digest(anchorRaw), outputs: [out(50n)] }),
    ),
  );
  return { anchorRaw, orphan };
};

Deno.test('a stalled build parks the draft in building', () => {
  const ctx = makeTestContext();
  const { orphan } = stallingSetup(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({
    claims: [{ producer: orphan, outputIndex: 0n }],
    outputs: [out(50n)],
  });
  store.build(draft);

  assertEquals(draft.status.type, DraftStatusType.Building);
  assertThrows(() => store.update(draft, { claims: [], refs: [], outputs: [] }));
});

Deno.test('cancelling a stalled draft drops its retry hook', () => {
  const ctx = makeTestContext();
  const { anchorRaw, orphan } = stallingSetup(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({
    claims: [{ producer: orphan, outputIndex: 0n }],
    outputs: [out(50n)],
  });
  store.build(draft);
  store.cancel(draft);

  ingest(ctx, anchorRaw);

  assertEquals(draft.status.type, DraftStatusType.Cancelled);
});

// Expected: the retry produces exactly one block and marks the draft Built.
// Actual: attemptBuild only aborts its retry hook after ingesting, so its own
// ingestion re-enters the hook and it rebuilds until the stack overflows.
Deno.test('BUG: a retried build re-enters itself through its own ingestion', () => {
  const ctx = makeTestContext();
  const { anchorRaw, orphan } = stallingSetup(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({
    claims: [{ producer: orphan, outputIndex: 0n }],
    outputs: [out(50n)],
  });
  store.build(draft);
  assertEquals(draft.status.type, DraftStatusType.Building);

  let ingested = 0;
  ctx.get(BlockStore).onIngest(() => ingested++);
  ingest(ctx, anchorRaw);

  assertEquals(draft.status.type, DraftStatusType.Built);
  assertEquals(ingested, 2, 'the anchor plus exactly one built block');
});

// Expected: the ready draft's 1000 surplus funds the deficit, both drafts are
// built into one balanced block. Actual: selectReadyFunds returns nothing, so the
// block is published with an output and no claim at all (wp 5.2).
Deno.test('BUG: a ready draft that exactly covers the deficit is not selected', () => {
  const ctx = makeTestContext();
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const funding = store.create({
    claims: [{ producer: genesis, outputIndex: 0n }],
    outputs: [out(999_000n)],
  });
  store.lock(funding);
  assertEquals(funding.ioDelta, -1_000n);

  const spending = store.create({ outputs: [out(1_000n)] });
  assertEquals(spending.ioDelta, 1_000n);
  store.build(spending);

  const block = builtBlock(spending);
  assertEquals(
    DraftStatusType[funding.status.type],
    DraftStatusType[DraftStatusType.Built],
  );
  assertEquals(builtBlock(funding).hash.toHex(), block.hash.toHex());
  assertEquals(block.payload.claims.length, 1);
  assertEquals(
    block.payload.outputs.reduce((acc, o) => acc + o.amount, 0n),
    1_000_000n,
  );
});

Deno.test('BUG: selectReadyFunds drops the candidate that completes the cover', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [3n, 4n]);
  const store = ctx.get(DraftStore);

  const three = fundingDraft(store, source, 0);
  const four = fundingDraft(store, source, 1);
  store.lock(three);
  store.lock(four);

  const selected = internals(store).selectReadyFunds(7n);

  assertEquals(selected.map(surplus).toSorted(compareBigints), [3n, 4n]);
  assertEquals(totalSurplus(selected), 7n);
  assertEquals(new Set(selected).size, 2);
  assertEquals(selected.includes(three) && selected.includes(four), true);
});

Deno.test('BUG: selectReadyFunds returns nothing when one large candidate suffices', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [1n, 2n, 20n]);
  const store = ctx.get(DraftStore);

  const one = fundingDraft(store, source, 0);
  const two = fundingDraft(store, source, 1);
  const twenty = fundingDraft(store, source, 2);
  store.lock(one);
  store.lock(two);
  store.lock(twenty);

  const selected = internals(store).selectReadyFunds(20n);

  assertEquals(selected.map(surplus), [20n]);
  assertEquals(selected[0], twenty);
  assertEquals([one, two].some((d) => selected.includes(d)), false);
});

Deno.test('selectReadyFunds ignores drafts that are not ready or not in surplus', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [10n]);
  const store = ctx.get(DraftStore);

  const populating = fundingDraft(store, source, 0);
  const needing = store.create({ outputs: [out(10n)] });
  store.lock(needing);

  assertEquals(internals(store).selectReadyFunds(10n), []);
  assertEquals(populating.status.type, DraftStatusType.Populating);
  assertEquals(needing.status.type, DraftStatusType.Ready);
});

Deno.test('merging drafts concatenates claims, refs and outputs in order', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [1n, 2n]);
  const store = ctx.get(DraftStore);

  const merged = internals(store).mergeDrafts([
    { claims: [{ producer: source, outputIndex: 0n }], refs: [], outputs: [out(1n)] },
    {
      claims: [{ producer: source, outputIndex: 1n }],
      refs: [{ producer: source, outputIndex: 0n }],
      outputs: [out(2n), out(3n)],
    },
  ]);

  assertEquals(merged.claims.map((x) => x.outputIndex), [0n, 1n]);
  assertEquals(merged.refs.map((x) => x.outputIndex), [0n]);
  assertEquals(merged.outputs, [out(1n), out(2n), out(3n)]);
});

// Expected: the second draft's outputs land at merged index 2, so its self-claim
// has to move with them. Actual: it still reads 0 and claims the first draft's
// output (the TODO(claude) in mergeDrafts).
Deno.test('BUG: merging does not remap DRAFT_SELF claims', () => {
  const ctx = makeTestContext();
  const store = ctx.get(DraftStore);

  const merged = internals(store).mergeDrafts([
    { claims: [], refs: [], outputs: [out(1n), out(2n)] },
    {
      claims: [{ producer: DRAFT_SELF, outputIndex: 0n }],
      refs: [{ producer: DRAFT_SELF, outputIndex: 0n }],
      outputs: [out(3n)],
    },
  ]);

  assertEquals(merged.claims.map((x) => x.outputIndex), [2n]);
  assertEquals(merged.refs.map((x) => x.outputIndex), [2n]);
});
