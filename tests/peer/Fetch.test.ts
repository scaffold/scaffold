import { assertEquals } from '@std/assert';
import { BlockStore } from '../../src/graph/BlockStore.ts';
import { DraftStore } from '../../src/graph/DraftStore.ts';
import { type Block, type Draft, type DraftPayload, type Output } from '../../src/graph/types.ts';
import { Context } from '../../src/Context.ts';
import { Fetch } from '../../src/peer/Fetch.ts';
import { str2bin } from '../../src/util/buffer.ts';
import { Hash } from '../../src/util/Hash.ts';
import { bin2hex } from '../../src/util/hex.ts';
import { makePublishHarness } from '../helpers/blocks.ts';
import { makeTestContext } from '../helpers/v2.ts';
import { AGGREGATION_CONTRACT } from '../../src/contract/static/Aggregation.ts';
import { HELLO_CONTRACT } from '../../src/contract/static/Hello.ts';
import { createSource } from '../../src/contract/createSource.ts';
import { neverAbort } from '../../src/util/abortable.ts';

const CONTRACT = Hash.digest('demo');
const PARAMS = str2bin('world');
const ANSWER = str2bin('Hello world!');

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

  const { genesis, publish } = makePublishHarness(ctx);

  const ingested: Block[] = [];
  ctx.get(BlockStore).onIngest((block) => ingested.push(block), neverAbort);

  const results: (Uint8Array | null)[] = [];
  const collect = () => (result: { body: Uint8Array } | null) =>
    results.push(result === null ? null : result.body);

  return { ctx, genesis, drafts, ingested, publish, results, collect };
}

/** The shape `EnvContractProvider.generate` produces for `setResult`. */
const answerOutput = (body: Uint8Array, params = PARAMS): Output => ({
  contract: CONTRACT,
  params,
  body,
  amount: 0n,
});

Deno.test('fetch publishes the query as an unclaimed zero-amount output', async () => {
  const h = harness();
  await h.ctx.get(Fetch).fetch({
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
  assertEquals(payload.outputs[0].body, undefined);
  assertEquals(Hash.equals(payload.outputs[1].contract, AGGREGATION_CONTRACT), true);
  assertEquals(payload.claims, []);
  assertEquals(payload.refs, []);
  assertEquals(payload.aggregates, []);
  assertEquals(payload.anchor.toHex(), h.genesis.hash.toHex());
});

Deno.test('fetch delivers an answer ingested after the call', async () => {
  const h = harness();
  await h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  h.publish([answerOutput(ANSWER)], [0n]);

  assertEquals(h.results.length, 1);
  assertEquals(h.results[0], ANSWER);
});

Deno.test("fetch ignores another peer's query block for the same predicate", async () => {
  const h = harness();
  await h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  h.publish([{ contract: CONTRACT, params: PARAMS, amount: 0n }], []);

  assertEquals(h.results, []);
});

Deno.test('fetch ignores an unclaimed answer output', async () => {
  const h = harness();
  await h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  // An answer is asserted by self-claiming it (`EnvContractProvider.verify`); an
  // unclaimed {predicate, body} output states nothing.
  h.publish([answerOutput(ANSWER)], []);

  assertEquals(h.results, []);
});

Deno.test('fetch ignores answers under a different predicate', async () => {
  const h = harness();
  await h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  h.publish([answerOutput(ANSWER, str2bin('elsewhere'))], [0n]);
  h.publish([{ contract: Hash.digest('other'), params: PARAMS, body: ANSWER, amount: 0n }], [0n]);
  assertEquals(h.results, []);

  h.publish([answerOutput(ANSWER)], [0n]);
  assertEquals(h.results.length, 1);
});

Deno.test('fetch delivers the answer at the claimed output index', async () => {
  const h = harness();
  await h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  h.publish([answerOutput(str2bin('unclaimed')), answerOutput(ANSWER)], [1n]);

  assertEquals(h.results.length, 1);
  assertEquals(h.results[0], ANSWER);
});

Deno.test('fetch stops delivering once the signal aborts', async () => {
  const h = harness();
  const controller = new AbortController();
  await h.ctx.get(Fetch).fetch({
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

Deno.test('fetch builds structured params through the contract', async () => {
  const h = harness();
  await h.ctx.get(Fetch).fetch({
    contract: HELLO_CONTRACT,
    params: () => createSource({ name: 'world' }),
    onResult: () => {},
  });

  assertEquals(h.ingested.length, 1);
  const output = h.ingested[0].payload.outputs[0];
  assertEquals(Hash.equals(output.contract, HELLO_CONTRACT), true);
  assertEquals(bin2hex(output.params), bin2hex(PARAMS));
});

// Ignored because we need to set up the harness with CONTRACT in the ContractProvider to make serialization/parsing work
Deno.test.ignore('FetchResult.parse resolves the unparsed body', async () => {
  const h = harness();
  const parsed: unknown[] = [];
  await h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: (result) => parsed.push(result === null ? null : result.parse()),
  });

  h.publish([answerOutput(ANSWER)], [0n]);

  assertEquals(parsed.length, 1);
  assertEquals(await parsed[0], { message: ANSWER });
});

Deno.test('fetch delivers an answer already in the store', async () => {
  const h = harness();
  h.publish([answerOutput(ANSWER)], [0n]);

  await h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    onResult: h.collect(),
  });

  assertEquals(h.results.length, 1);
  assertEquals(h.results[0], ANSWER);
});

Deno.test('fetch on an already-aborted signal publishes nothing', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();

  await h.ctx.get(Fetch).fetch({
    contract: CONTRACT,
    params: PARAMS,
    signal: controller.signal,
    onResult: h.collect(),
  });

  assertEquals(h.ingested.length, 0);
  assertEquals(h.drafts.created.length, 0);
});

Deno.test('aborting the fetch signal cancels the draft it created', async () => {
  const h = harness();
  const controller = new AbortController();

  await h.ctx.get(Fetch).fetch({
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
