import { assertEquals, assertThrows } from '@std/assert';
import { Context } from '../../src/Context.ts';
import { AtomSerializer } from '../../src/graph/AtomSerializer.ts';
import { BlockStore } from '../../src/graph/BlockStore.ts';
import { DraftStore, DraftStoreConfig, EXTRA_OUTPUT_PAYLOAD } from '../../src/graph/DraftStore.ts';
import {
  AtomSource,
  AtomType,
  Block,
  BlockPayload,
  Draft,
  DRAFT_SELF,
  DRAFT_TYPE,
  DraftPayload,
  DraftStatusType,
  Output,
} from '../../src/graph/types.ts';
import { Hash, ZERO_HASH } from '../../src/util/Hash.ts';
import { makeTestContext } from '../helpers/v2.ts';
import { secp } from '../../src/util/secp.ts';
import { AGGREGATION_CONTRACT } from '../../src/contract/static/Aggregation.ts';
import { SIGNATURE_CONTRACT } from '../../src/contract/static/Signature.ts';

const out = (amount: bigint, contract = ZERO_HASH): Output => ({
  contract,
  params: new Uint8Array(),
  amount,
});

const aggregationOut = (amount = 0n) => out(amount, AGGREGATION_CONTRACT);

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
  ctx.get(AtomSerializer).serialize(AtomType.Block, payload);

const ingest = (ctx: Context, raw: Uint8Array): Block =>
  ctx.get(BlockStore).ingest({ source: AtomSource.Local, receivedAt: 0, raw });

const ingestGenesis = (ctx: Context): Block =>
  ctx.get(BlockStore).ingest({
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw: ctx.config.genesis,
  });

type ExtraPayload = DraftPayload & { type: typeof EXTRA_OUTPUT_PAYLOAD };

type BalanceEntry = Draft | ExtraPayload;

interface DraftStoreInternals {
  balanceFunds(draft: Draft): BalanceEntry[];
  mergeDrafts(drafts: DraftPayload[]): DraftPayload;
}

const internals = (store: DraftStore) => store as unknown as DraftStoreInternals;

const surplus = (draft: Draft) => -draft.ioDelta;

const compareBigints = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;

const sumOutputs = (outputs: Output[]) => outputs.reduce((acc, o) => acc + o.amount, 0n);

const selectedDrafts = (entries: BalanceEntry[]): Draft[] =>
  entries.filter((e): e is Draft => e.type === DRAFT_TYPE);

const extraPayloads = (entries: BalanceEntry[]): ExtraPayload[] =>
  entries.filter((e): e is ExtraPayload => e.type === EXTRA_OUTPUT_PAYLOAD);

const isAggregation = (payload: ExtraPayload): boolean =>
  payload.outputs.every((o) => Hash.equals(o.contract, AGGREGATION_CONTRACT));

const changePayloads = (entries: BalanceEntry[]): ExtraPayload[] =>
  extraPayloads(entries).filter((p) => !isAggregation(p));

const aggregationPayloads = (entries: BalanceEntry[]): ExtraPayload[] =>
  extraPayloads(entries).filter(isAggregation);

// The whole point of balanceFunds: the payload set it returns merges into a balanced
// block, so its combined ioDelta is zero.
const netDelta = (entries: BalanceEntry[]): bigint =>
  entries.reduce(
    (acc, e) => acc + (e.type === DRAFT_TYPE ? e.ioDelta : sumOutputs(e.outputs)),
    0n,
  );

const GENESIS_AMOUNT = 1_000_000n;

// Claims the whole genesis output and pays it straight back out, so it needs no funding.
const genesisDraft = (store: DraftStore, genesis: Block): Draft =>
  store.create({
    claims: [{ producer: genesis, outputIndex: 0n }],
    outputs: [out(GENESIS_AMOUNT)],
  });

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
  ingest(ctx, serialize(ctx, blockPayload({ outputs: amounts.map((amount) => out(amount)) })));

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
  assertEquals(block.payload.outputs, [out(1_000_000n), aggregationOut()]);
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
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = genesisDraft(store, genesis);
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
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const seen: (Block | undefined)[] = [];
  const draft = genesisDraft(store, genesis);
  store.onBuilt(draft, (block) => seen.push(block));
  store.build(draft);

  assertEquals(seen, [builtBlock(draft)]);
});

Deno.test('onBuilt fires immediately for an already built draft', () => {
  const ctx = makeTestContext();
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = genesisDraft(store, genesis);
  store.build(draft);

  const seen: (Block | undefined)[] = [];
  store.onBuilt(draft, (block) => seen.push(block));

  assertEquals(seen, [builtBlock(draft)]);
});

Deno.test('onBuilt ignores an already aborted signal', () => {
  const ctx = makeTestContext();
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const seen: (Block | undefined)[] = [];
  const draft = genesisDraft(store, genesis);
  const hooks = new AbortController();
  hooks.abort();
  store.onBuilt(draft, (block) => seen.push(block), hooks.signal);
  store.build(draft);

  assertEquals(seen, []);
});

Deno.test('onBuilt unsubscribes when its signal aborts', () => {
  const ctx = makeTestContext();
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const seen: (Block | undefined)[] = [];
  const draft = genesisDraft(store, genesis);
  const hooks = new AbortController();
  store.onBuilt(draft, (block) => seen.push(block), hooks.signal);
  hooks.abort();
  store.build(draft);

  assertEquals(seen, []);
});

// The build path ingests with listeners suppressed and replays them afterwards, so a
// draft is already Built by the time anyone hears about its block.
Deno.test("built blocks are ingested before the draft's onBuilt is called", () => {
  const ctx = makeTestContext();
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = genesisDraft(store, genesis);
  const order: string[] = [];
  const statusAtIngest: DraftStatusType[] = [];
  store.onBuilt(draft, () => order.push('draft_build'));
  ctx.get(BlockStore).onIngest(() => {
    order.push('block_ingest');
    statusAtIngest.push(draft.status.type);
  });
  store.build(draft);

  assertEquals(order, ['block_ingest', 'draft_build']);
  assertEquals(statusAtIngest, [DraftStatusType.Built]);
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

Deno.test('a retried build re-enters itself through its own ingestion', () => {
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

Deno.test('balanceFunds adds no funding to a draft that is already balanced', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [10n]);
  const store = ctx.get(DraftStore);

  const balanced = store.create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [out(10n)],
  });

  const selected = internals(store).balanceFunds(balanced);

  assertEquals(selectedDrafts(selected), [balanced]);
  assertEquals(changePayloads(selected), []);
  assertEquals(netDelta(selected), 0n);
});

// Every block we build carries one, addressed to the aggregation contract with no
// params so any aggregator can claim it (wp 7).
Deno.test('balanceFunds appends an aggregation output to every draft', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [10n]);
  const store = ctx.get(DraftStore);

  const balanced = store.create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [out(10n)],
  });

  const selected = internals(store).balanceFunds(balanced);

  assertEquals(aggregationPayloads(selected).map((p) => p.outputs), [[aggregationOut()]]);
  assertEquals(selected.at(-1), aggregationPayloads(selected)[0]);
});

Deno.test('the aggregation fee is paid out of the surplus that would have been change', () => {
  const ctx = makeTestContext();
  ctx.configure(DraftStoreConfig, { aggregationFee: 10n });
  const source = sourceBlock(ctx, [100n]);
  const store = ctx.get(DraftStore);

  const spending = store.create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [out(90n)],
  });

  const selected = internals(store).balanceFunds(spending);

  assertEquals(aggregationPayloads(selected).map((p) => p.outputs), [[aggregationOut(10n)]]);
  assertEquals(changePayloads(selected), []);
  assertEquals(netDelta(selected), 0n);
});

// Without the fee the funding draft would overshoot by 10 and leave change.
Deno.test('the aggregation fee counts towards the deficit candidates have to cover', () => {
  const ctx = makeTestContext();
  ctx.configure(DraftStoreConfig, { aggregationFee: 10n });
  const source = sourceBlock(ctx, [15n]);
  const store = ctx.get(DraftStore);

  const funding = fundingDraft(store, source, 0);
  store.lock(funding);

  const spending = store.create({ outputs: [out(5n)] });
  const selected = internals(store).balanceFunds(spending);

  assertEquals(selectedDrafts(selected), [spending, funding]);
  assertEquals(changePayloads(selected), []);
  assertEquals(netDelta(selected), 0n);
});

// An aggregation block sets its own fee, so the config one does not apply to it.
Deno.test('a draft that brings its own aggregation output does not get a second', () => {
  const ctx = makeTestContext();
  ctx.configure(DraftStoreConfig, { aggregationFee: 10n });
  const source = sourceBlock(ctx, [10n]);
  const store = ctx.get(DraftStore);

  const aggregating = store.create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [out(6n), aggregationOut(4n)],
  });

  const selected = internals(store).balanceFunds(aggregating);

  assertEquals(selectedDrafts(selected), [aggregating]);
  assertEquals(extraPayloads(selected), []);
  assertEquals(netDelta(selected), 0n);
});

// What an aggregation block looks like from here: it claims the markers of the trees
// it merges and emits its own, so it arrives as a surplus draft (wp 7).
Deno.test('a ready aggregation draft rides along instead of a minted output', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [10n]);
  const store = ctx.get(DraftStore);

  const aggregating = store.create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [aggregationOut(4n)],
  });
  store.lock(aggregating);

  const spending = store.create({ outputs: [out(6n)] });
  const selected = internals(store).balanceFunds(spending);

  assertEquals(selectedDrafts(selected), [spending, aggregating]);
  assertEquals(extraPayloads(selected), []);
  assertEquals(netDelta(selected), 0n);
});

// Two markers would make the block aggregatable into two trees at once, breaking the
// one-aggregation-per-block invariant the forest rests on (wp 4.3).
Deno.test('a second aggregation draft is not pulled in to cover a deficit', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [10n, 10n]);
  const store = ctx.get(DraftStore);

  const first = store.create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [aggregationOut()],
  });
  const second = store.create({
    claims: [{ producer: source, outputIndex: 1n }],
    outputs: [aggregationOut()],
  });
  store.lock(first);
  store.lock(second);

  const spending = store.create({ outputs: [out(20n)] });
  const selected = internals(store).balanceFunds(spending);

  assertEquals(selectedDrafts(selected), [spending, first]);
  assertEquals(netDelta(selected), 10n, 'underfunded rather than carrying a second marker');
});

Deno.test('a draft carrying two aggregation outputs is rejected', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [10n]);
  const store = ctx.get(DraftStore);

  const doubled = store.create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [aggregationOut(4n), aggregationOut(6n)],
  });

  assertThrows(() => internals(store).balanceFunds(doubled));
});

Deno.test('balanceFunds pays its own surplus into a signature change output', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [10n]);
  const store = ctx.get(DraftStore);

  const spending = store.create({
    claims: [{ producer: source, outputIndex: 0n }],
    outputs: [out(4n)],
  });

  const selected = internals(store).balanceFunds(spending);

  assertEquals(selectedDrafts(selected), [spending]);
  assertEquals(changePayloads(selected).map((p) => p.claims), [[]]);
  assertEquals(changePayloads(selected).map((p) => p.refs), [[]]);
  assertEquals(changePayloads(selected).flatMap((p) => p.outputs), [{
    contract: SIGNATURE_CONTRACT,
    params: secp.getPublicKey(ctx.config.selfPrivateKey, true),
    amount: 6n,
  }]);
  assertEquals(netDelta(selected), 0n);
});

Deno.test('a surplus draft builds a block carrying its change output', () => {
  const ctx = makeTestContext();
  const genesis = ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({
    claims: [{ producer: genesis, outputIndex: 0n }],
    outputs: [out(400_000n)],
  });
  store.build(draft);

  const block = builtBlock(draft);
  assertEquals(block.payload.outputs.map((o) => o.amount), [400_000n, 600_000n, 0n]);
  assertEquals(block.payload.outputs[1].contract.toHex(), SIGNATURE_CONTRACT.toHex());
  assertEquals(block.payload.outputs[2].contract.toHex(), AGGREGATION_CONTRACT.toHex());
  assertEquals(sumOutputs(block.payload.outputs), GENESIS_AMOUNT);
});

// The ready draft's 1000 surplus funds the deficit, so both build into one block (wp 5.2).
Deno.test('a ready draft that exactly covers the deficit is selected', () => {
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

Deno.test('balanceFunds keeps the candidate that completes the cover', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [3n, 4n]);
  const store = ctx.get(DraftStore);

  const three = fundingDraft(store, source, 0);
  const four = fundingDraft(store, source, 1);
  store.lock(three);
  store.lock(four);

  const spending = store.create({ outputs: [out(7n)] });
  const selected = internals(store).balanceFunds(spending);

  assertEquals(selected[0], spending);
  assertEquals(
    selectedDrafts(selected).slice(1).map(surplus).toSorted(compareBigints),
    [3n, 4n],
  );
  assertEquals(changePayloads(selected), []);
  assertEquals(netDelta(selected), 0n);
});

Deno.test('balanceFunds takes only the large candidate when it suffices', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [1n, 2n, 20n]);
  const store = ctx.get(DraftStore);

  const one = fundingDraft(store, source, 0);
  const two = fundingDraft(store, source, 1);
  const twenty = fundingDraft(store, source, 2);
  store.lock(one);
  store.lock(two);
  store.lock(twenty);

  const spending = store.create({ outputs: [out(20n)] });
  const selected = internals(store).balanceFunds(spending);

  assertEquals(selectedDrafts(selected), [spending, twenty]);
  assertEquals([one, two].some((d) => selected.includes(d)), false);
  assertEquals(changePayloads(selected), []);
  assertEquals(netDelta(selected), 0n);
});

Deno.test('a candidate that overshoots the deficit leaves change', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [8n]);
  const store = ctx.get(DraftStore);

  const funding = fundingDraft(store, source, 0);
  store.lock(funding);

  const spending = store.create({ outputs: [out(5n)] });
  const selected = internals(store).balanceFunds(spending);

  assertEquals(selectedDrafts(selected), [spending, funding]);
  assertEquals(changePayloads(selected).flatMap((p) => p.outputs).map((o) => o.amount), [3n]);
  assertEquals(netDelta(selected), 0n);
});

Deno.test('balanceFunds ignores drafts that are not ready or not in surplus', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [10n, 10n]);
  const store = ctx.get(DraftStore);

  const populating = fundingDraft(store, source, 0);
  const cancelled = fundingDraft(store, source, 1);
  store.cancel(cancelled);
  const needing = store.create({ outputs: [out(10n)] });
  store.lock(needing);

  const spending = store.create({ outputs: [out(10n)] });
  const selected = internals(store).balanceFunds(spending);

  assertEquals(selectedDrafts(selected), [spending]);
  assertEquals(changePayloads(selected), []);
  assertEquals(populating.status.type, DraftStatusType.Populating);
  assertEquals(cancelled.status.type, DraftStatusType.Cancelled);
  assertEquals(needing.status.type, DraftStatusType.Ready);
});

// Nothing covers the deficit, so the merged payload reaches the builder unbalanced and
// its assert throws straight out of `build()` rather than parking the draft -- see
// TODO.v2.md.
Deno.test('a draft nothing can fund throws out of build', () => {
  const ctx = makeTestContext();
  ingestGenesis(ctx);
  const store = ctx.get(DraftStore);

  const draft = store.create({ outputs: [out(1n)] });

  assertThrows(() => store.build(draft));
  assertEquals(draft.status.type, DraftStatusType.Building);
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

// The second draft's outputs land at merged index 2, so its self-claim moves with them.
Deno.test('merging remaps DRAFT_SELF claims onto the merged output vector', () => {
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
  assertEquals(merged.claims.map((x) => x.producer), [DRAFT_SELF]);
});

Deno.test('merging leaves the first draft self-claims where they are', () => {
  const ctx = makeTestContext();
  const source = sourceBlock(ctx, [4n]);
  const store = ctx.get(DraftStore);

  const merged = internals(store).mergeDrafts([
    {
      claims: [{ producer: DRAFT_SELF, outputIndex: 1n }, { producer: source, outputIndex: 0n }],
      refs: [],
      outputs: [out(1n), out(2n)],
    },
    {
      claims: [{ producer: DRAFT_SELF, outputIndex: 1n }],
      refs: [],
      outputs: [out(3n), out(4n)],
    },
  ]);

  assertEquals(merged.claims.map((x) => x.outputIndex), [1n, 0n, 3n]);
  assertEquals(merged.claims.map((x) => x.producer), [DRAFT_SELF, source, DRAFT_SELF]);
});

Deno.test('merging rejects a self-claim outside the draft it belongs to', () => {
  const ctx = makeTestContext();
  const store = ctx.get(DraftStore);

  const merge = (outputIndex: bigint) =>
    internals(store).mergeDrafts([
      { claims: [], refs: [], outputs: [out(1n), out(2n)] },
      { claims: [{ producer: DRAFT_SELF, outputIndex }], refs: [], outputs: [out(3n)] },
    ]);

  assertThrows(() => merge(1n));
  assertThrows(() => merge(-1n));
});
