import { assertEquals, assertThrows } from '@std/assert';
import { AtomSerializer } from '../../src/graph/AtomSerializer.ts';
import { BlockStore } from '../../src/graph/BlockStore.ts';
import { DraftStore } from '../../src/graph/DraftStore.ts';
import {
  AtomSource,
  AtomType,
  type Block,
  type BlockPayload,
  type Draft,
  type DraftPayload,
  type Output,
} from '../../src/graph/types.ts';
import { Context } from '../../src/Context.ts';
import { Fetch } from '../../src/peer/Fetch.ts';
import { str2bin } from '../../src/util/buffer.ts';
import { Hash } from '../../src/util/Hash.ts';
import { bin2hex } from '../../src/util/hex.ts';
import { makeTestContext } from '../helpers/v2.ts';
import { AGGREGATION_CONTRACT } from '../../src/contract/static/Aggregation.ts';

const CONTRACT = Hash.digest('demo');
const PARAMS = str2bin('world');
const ANSWER = str2bin('Hello, world');

class RecordingDraftStore extends DraftStore {
  created: Draft[] = [];
  cancelled: Draft[] = [];

  override create(attrs?: Partial<DraftPayload>): Draft {
    const draft = super.create(attrs);
    this.created.push(draft);
    return draft;
  }

  override cancel(draft: Draft) {
    this.cancelled.push(draft);
    super.cancel(draft);
  }
}

interface Harness {
  ctx: Context;
  genesis: Block;
  drafts: RecordingDraftStore;
  ingested: Block[];
  publish(outputs: Output[], claims: bigint[]): Block;
  results: (Uint8Array | null)[];
  collect(): (result: { body: Uint8Array } | null) => void;
}

function harness(): Harness {
  const ctx = makeTestContext();
  const drafts = new RecordingDraftStore(ctx);
  ctx.mock(DraftStore, drafts);

  const store = ctx.get(BlockStore);
  const genesis = store.ingest({
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw: ctx.config.genesis,
  });

  const ingested: Block[] = [];
  store.onIngest((block) => ingested.push(block));

  let timestampMs = 0;
  const publish = (outputs: Output[], claims: bigint[]): Block => {
    const payload: BlockPayload = {
      anchor: genesis.hash,
      chain: [{ weight: 0n, throughput: 0n }],
      aggregates: [],
      claims,
      refs: [],
      outputs,
      timestampMs: ++timestampMs,
    };
    const raw = ctx.get(AtomSerializer).serialize(AtomType.Block, payload);
    return store.ingest({ source: AtomSource.Remote, receivedAt: timestampMs, raw });
  };

  const results: (Uint8Array | null)[] = [];
  const collect = () => (result: { body: Uint8Array } | null) =>
    results.push(result === null ? null : result.body);

  return { ctx, genesis, drafts, ingested, publish, results, collect };
}

/** The shape `EnvContractProvider.generate` produces for `setResult`. */
const answerOutput = (data: Uint8Array, params = PARAMS): Output => ({
  contract: CONTRACT,
  params,
  data,
  amount: 0n,
});

Deno.test('fetch publishes the query as an unclaimed zero-amount output', () => {
  const h = harness();
  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: () => {},
  });

  assertEquals(h.ingested.length, 1);
  const payload = h.ingested[0].payload;
  // The query output, then the aggregation output every built block carries.
  assertEquals(payload.outputs.length, 2);
  assertEquals(Hash.equals(payload.outputs[0].contract, CONTRACT), true);
  assertEquals(bin2hex(payload.outputs[0].params), bin2hex(PARAMS));
  assertEquals(payload.outputs[0].amount, 0n);
  assertEquals(payload.outputs[0].data, undefined);
  assertEquals(Hash.equals(payload.outputs[1].contract, AGGREGATION_CONTRACT), true);
  assertEquals(payload.claims, []);
  assertEquals(payload.refs, []);
  assertEquals(payload.aggregates, []);
  assertEquals(payload.anchor.toHex(), h.genesis.hash.toHex());
});

Deno.test('fetch delivers an answer ingested after the call', () => {
  const h = harness();
  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  h.publish([answerOutput(ANSWER)], [0n]);

  assertEquals(h.results.length, 1);
  assertEquals(h.results[0], ANSWER);
});

Deno.test("fetch ignores another peer's query block for the same predicate", () => {
  const h = harness();
  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  h.publish([{ contract: CONTRACT, params: PARAMS, amount: 0n }], []);

  assertEquals(h.results, []);
});

Deno.test('fetch ignores an unclaimed answer output', () => {
  const h = harness();
  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  // An answer is asserted by self-claiming it (`EnvContractProvider.verify`); an
  // unclaimed {predicate, data} output states nothing.
  h.publish([answerOutput(ANSWER)], []);

  assertEquals(h.results, []);
});

Deno.test('fetch ignores answers under a different predicate', () => {
  const h = harness();
  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  h.publish([answerOutput(ANSWER, str2bin('elsewhere'))], [0n]);
  h.publish([{ contract: Hash.digest('other'), params: PARAMS, data: ANSWER, amount: 0n }], [0n]);
  assertEquals(h.results, []);

  h.publish([answerOutput(ANSWER)], [0n]);
  assertEquals(h.results.length, 1);
});

Deno.test('fetch delivers the answer at the claimed output index', () => {
  const h = harness();
  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  h.publish([answerOutput(str2bin('unclaimed')), answerOutput(ANSWER)], [1n]);

  assertEquals(h.results.length, 1);
  assertEquals(h.results[0], ANSWER);
});

Deno.test('fetch stops delivering once the signal aborts', () => {
  const h = harness();
  const controller = new AbortController();
  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    signal: controller.signal,
    onResult: h.collect(),
  });

  h.publish([answerOutput(ANSWER)], [0n]);
  controller.abort();
  h.publish([answerOutput(str2bin('later'))], [0n]);

  assertEquals(h.results.length, 1);
});

Deno.test('fetch rejects Reader-based params', () => {
  const h = harness();
  assertThrows(
    () =>
      h.ctx.get(Fetch).fetch({
        contract: CONTRACT,
        params: () => str2bin('x') as never,
        onResult: () => {},
      }),
    Error,
    'Reader-based params are not supported yet',
  );
});

Deno.test('FetchResult.parse resolves the unparsed body', async () => {
  const h = harness();
  const parsed: unknown[] = [];
  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: (result) => parsed.push(result === null ? null : result.parse()),
  });

  h.publish([answerOutput(ANSWER)], [0n]);

  assertEquals(parsed.length, 1);
  assertEquals(await parsed[0], ANSWER);
});

// BUG: an answer already in the store is never delivered.
// src/peer/Fetch.ts only subscribes to future ingestions, so a fetch for a
// predicate the node already holds an answer for reports nothing at all. Expected: the
// answer is delivered (the codebase's own subscribe idiom, `DraftStore.onBuilt`, fires
// immediately when the state is already satisfied, and wp 11.2 has clients resolving
// from local state). Actual: onResult is never called.
Deno.test('BUG: fetch delivers an answer already in the store', () => {
  const h = harness();
  h.publish([answerOutput(ANSWER)], [0n]);

  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  assertEquals(h.results.length, 1);
  assertEquals(h.results[0], ANSWER);
});

// BUG: an already-aborted signal still publishes a block.
// src/peer/Fetch.ts creates and builds the draft before looking at
// input.signal, so an abandoned fetch still puts a query output on the graph
// permanently. Expected: nothing is published, matching BlockStore.onIngest and
// DraftStore.onBuilt, which both return early on an aborted signal. Actual: one block.
Deno.test('BUG: fetch on an already-aborted signal publishes nothing', () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();

  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    signal: controller.signal,
    onResult: h.collect(),
  });

  assertEquals(h.ingested.length, 0);
  assertEquals(h.drafts.created.length, 0);
});

// BUG: aborting the signal leaks the draft.
// src/peer/Fetch.ts hands input.signal to BlockStore.onIngest only, so the
// draft created at line 29 is never cancelled. Expected: DraftStore.cancel is called,
// since a build that stalled on placement keeps retrying on every ingestion (the
// onIngest subscription DraftStore.build registers) for a fetch the caller abandoned.
// Actual: cancel is never called.
Deno.test('BUG: aborting the fetch signal cancels the draft it created', () => {
  const h = harness();
  const controller = new AbortController();

  h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    signal: controller.signal,
    onResult: () => {},
  });
  assertEquals(h.drafts.created.length, 1);

  controller.abort();

  assertEquals(h.drafts.cancelled.length, 1);
  assertEquals(h.drafts.cancelled[0] === h.drafts.created[0], true);
});
