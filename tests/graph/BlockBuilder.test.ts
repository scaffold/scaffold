import { assertEquals, assertThrows } from '@std/assert';
import { Context } from '../../src/Context.ts';
import { AtomSerializer } from '../../src/graph/AtomSerializer.ts';
import { BlockBuilder, BlockBuilderBase } from '../../src/graph/BlockBuilder.ts';
import { BlockStore } from '../../src/graph/BlockStore.ts';
import { AnchorChainNode } from '../../src/graph/ClaimIndex.ts';
import { PlacementNode, PlacementRequest, PlacementResult } from '../../src/graph/Placement.ts';
import {
  AGGREGATION_CONTRACT,
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
  OutputResolverType,
  ResolvingClaim,
  ResolvingRef,
} from '../../src/graph/types.ts';
import { error } from '../../src/util/functional.ts';
import { Hash, ZERO_HASH } from '../../src/util/Hash.ts';
import { makeTestContext } from '../helpers/v2.ts';
import { AggregatorNodeBase } from '../../src/logic/Forest.ts';

const out = (amount: bigint, contract = ZERO_HASH): Output => ({
  contract,
  params: new Uint8Array(),
  amount,
});

const aggregationOut = (amount: bigint) => out(amount, AGGREGATION_CONTRACT);

const fakeBlock = (name: string, outputs: Output[] = []): Block => ({
  hash: Hash.digest(name),
  type: AtomType.Block,
  source: AtomSource.Remote,
  receivedAt: 0,
  raw: new Uint8Array(),
  message: new Uint8Array(),
  fromConnections: [],
  toConnections: new Set(),
  payload: {
    anchor: ZERO_HASH,
    chain: [],
    aggregates: [],
    claims: [],
    refs: [],
    outputs,
    timestampMs: 0,
  },
  aggregates: [],
  claims: [],
  refs: [],
  anchoringNodes: [],
  aggregatingNodes: [],
  resolvingOutputs: new Map(),
  listeners: new Set(),
});

const fakeDraft = (): Draft => ({
  type: DRAFT_TYPE,
  claims: [],
  refs: [],
  outputs: [],
  status: { type: DraftStatusType.Populating },
  ioDelta: 0n,
  builtBlocks: [],
  listeners: new Set(),
});

const payload = (attrs: Partial<DraftPayload> = {}): DraftPayload => ({
  claims: [],
  refs: [],
  outputs: [],
  ...attrs,
});

const addResolver = (
  producer: Block,
  outputIdx: bigint,
  resolver: ResolvingClaim | ResolvingRef,
) => {
  const arr = producer.resolvingOutputs.get(outputIdx) ?? [];
  arr.push(resolver);
  producer.resolvingOutputs.set(outputIdx, arr);
};

const rivalClaim = (producer: Block, outputIdx: bigint, claimer: Block | Draft) =>
  addResolver(producer, outputIdx, {
    type: OutputResolverType.Claim,
    producer,
    outputIdx,
    claimer,
    claimIdx: 0,
    resolved: true,
  });

const rivalRef = (producer: Block, outputIdx: bigint, reffer: Block | Draft) =>
  addResolver(producer, outputIdx, {
    type: OutputResolverType.Ref,
    producer,
    outputIdx,
    reffer,
    refIdx: 0,
    resolved: true,
  });

interface StubOptions {
  place?: (request: PlacementRequest) => PlacementResult;
  resolveClaimIndex?: (
    anchorChain: AnchorChainNode[],
    outputBlock: AggregatorNodeBase & AnchorChainNode,
    outputIndex: bigint,
  ) => bigint;
  countOutputs?: (block: Block) => bigint;
}

interface ResolveCall {
  anchorChain: AnchorChainNode[];
  outputBlock: AggregatorNodeBase & AnchorChainNode;
  outputIndex: bigint;
}

class StubBuilder extends BlockBuilderBase {
  genesis = fakeBlock('genesis');
  anchor = fakeBlock('anchor');
  placeRequests: PlacementRequest[] = [];
  resolveCalls: ResolveCall[] = [];
  countedBlocks: Block[] = [];

  constructor(private options: StubOptions = {}) {
    super();
  }

  protected override getGenesisBlock(): PlacementNode {
    return this.genesis;
  }

  protected override nowMs(): number {
    return 0;
  }

  protected override place(request: PlacementRequest): PlacementResult {
    this.placeRequests.push(request);
    return this.options.place?.(request) ?? { ok: true, anchorChain: [this.anchor] };
  }

  protected override getBlock(_hash: Hash): PlacementNode {
    return error('getBlock is not expected to be reached by build');
  }

  protected override resolveClaimIndex(
    anchorChain: AnchorChainNode[],
    outputBlock: AggregatorNodeBase & AnchorChainNode,
    outputIndex: bigint,
  ): bigint {
    this.resolveCalls.push({ anchorChain, outputBlock, outputIndex });
    return this.options.resolveClaimIndex?.(anchorChain, outputBlock, outputIndex) ??
      BigInt(this.resolveCalls.length * 100);
  }

  protected override countOutputs(block: Block): bigint {
    this.countedBlocks.push(block);
    return this.options.countOutputs?.(block) ?? BigInt(block.payload.outputs.length);
  }
}

const okPayload = (result: ReturnType<BlockBuilderBase['build']>) => {
  if (!result.ok) throw new Error('expected a successful build');
  return result.payload;
};

Deno.test('build carries the draft outputs and the placed anchor into the payload', () => {
  const builder = new StubBuilder();
  const funder = fakeBlock('funder', [out(10n)]);
  const outputs = [out(7n), out(3n)];

  const built = okPayload(builder.build(payload({
    claims: [{ producer: funder, outputIndex: 0n }],
    outputs,
  })));

  assertEquals(built.outputs, outputs);
  assertEquals(built.anchor, builder.anchor.hash);
  assertEquals(built.claims, [100n]);
  assertEquals(built.refs, []);
  assertEquals(built.aggregates, []);
});

Deno.test('claim and ref producers are placement includes', () => {
  const builder = new StubBuilder();
  const claimed = fakeBlock('claimed', [out(5n)]);
  const reffed = fakeBlock('reffed', [out(5n)]);

  builder.build(payload({
    claims: [{ producer: claimed, outputIndex: 0n }, { producer: DRAFT_SELF, outputIndex: 0n }],
    refs: [{ producer: reffed, outputIndex: 0n }],
    outputs: [out(5n), out(5n)],
  }));

  assertEquals(builder.placeRequests.length, 1);
  assertEquals(builder.placeRequests[0].includes, [claimed, reffed]);
  assertEquals(builder.placeRequests[0].genesis, builder.genesis);
});

Deno.test('a claim on an aggregation output rolls that block up', () => {
  const builder = new StubBuilder({ countOutputs: () => 42n });
  const rolled = fakeBlock('rolled', [aggregationOut(1n)]);
  const plain = fakeBlock('plain', [out(1n)]);

  const built = okPayload(builder.build(payload({
    claims: [{ producer: plain, outputIndex: 0n }, { producer: rolled, outputIndex: 0n }],
    outputs: [out(2n)],
  })));

  assertEquals(built.aggregates, [{ block: rolled.hash, outputCount: 42n }]);
  assertEquals(builder.placeRequests[0].aggregates, [rolled]);
  assertEquals(builder.countedBlocks, [rolled]);
});

Deno.test('a claim on a non-aggregation output of an aggregating block is not a rollup', () => {
  const builder = new StubBuilder();
  const block = fakeBlock('mixed', [out(1n), aggregationOut(1n)]);

  const built = okPayload(builder.build(payload({
    claims: [{ producer: block, outputIndex: 0n }],
    outputs: [out(1n)],
  })));

  assertEquals(built.aggregates, []);
  assertEquals(builder.placeRequests[0].aggregates, []);
});

Deno.test('a claim index past the producer outputs is a hard error', () => {
  const builder = new StubBuilder();
  const block = fakeBlock('short', [out(1n)]);

  assertThrows(
    () => builder.build(payload({ claims: [{ producer: block, outputIndex: 1n }] })),
    Error,
    'out of range',
  );
});

Deno.test('a rival claim on a claimed output becomes a placement exclude', () => {
  const builder = new StubBuilder();
  const producer = fakeBlock('producer', [out(1n)]);
  const rival = fakeBlock('rival');
  rivalClaim(producer, 0n, rival);

  builder.build(payload({ claims: [{ producer, outputIndex: 0n }], outputs: [out(1n)] }));

  assertEquals(builder.placeRequests[0].excludes, [rival]);
});

Deno.test('a rival claim on a different output is not an exclude', () => {
  const builder = new StubBuilder();
  const producer = fakeBlock('producer', [out(1n), out(1n)]);
  const rival = fakeBlock('rival');
  rivalClaim(producer, 1n, rival);

  builder.build(payload({ claims: [{ producer, outputIndex: 0n }], outputs: [out(1n)] }));

  assertEquals(builder.placeRequests[0].excludes, []);
});

// wp 4.7: refs point at any output and do not consume it, so a reffer is no rival.
Deno.test('a ref on a claimed output is not an exclude', () => {
  const builder = new StubBuilder();
  const producer = fakeBlock('producer', [out(1n)]);
  const reffer = fakeBlock('reffer');
  rivalRef(producer, 0n, reffer);

  builder.build(payload({ claims: [{ producer, outputIndex: 0n }], outputs: [out(1n)] }));

  assertEquals(builder.placeRequests[0].excludes, []);
});

Deno.test('an unbuilt draft claiming the same output is not an exclude', () => {
  const builder = new StubBuilder();
  const producer = fakeBlock('producer', [out(1n)]);
  rivalClaim(producer, 0n, fakeDraft());

  builder.build(payload({ claims: [{ producer, outputIndex: 0n }], outputs: [out(1n)] }));

  assertEquals(builder.placeRequests[0].excludes, []);
});

Deno.test('rival claimants are deduplicated across claims', () => {
  const builder = new StubBuilder();
  const producer = fakeBlock('producer', [out(1n), out(1n)]);
  const rival = fakeBlock('rival');
  rivalClaim(producer, 0n, rival);
  rivalClaim(producer, 1n, rival);

  builder.build(payload({
    claims: [{ producer, outputIndex: 0n }, { producer, outputIndex: 1n }],
    outputs: [out(2n)],
  }));

  assertEquals(builder.placeRequests[0].excludes, [rival]);
});

Deno.test('a stalled placement returns the tips and resolves nothing', () => {
  const tips = [fakeBlock('tip0'), fakeBlock('tip1')];
  const builder = new StubBuilder({ place: () => ({ ok: false, tips }) });
  const producer = fakeBlock('producer', [out(1n)]);

  const result = builder.build(payload({
    claims: [{ producer, outputIndex: 0n }],
    outputs: [out(1n)],
  }));

  assertEquals(result, { ok: false, pendingAggregation: tips });
  assertEquals(builder.resolveCalls.length, 0);
});

Deno.test('claim indices resolve against the draft prepended to the anchor chain', () => {
  const builder = new StubBuilder({ countOutputs: () => 9n });
  const rolled = fakeBlock('rolled', [aggregationOut(3n)]);
  const outputs = [out(1n), out(2n)];

  builder.build(payload({ claims: [{ producer: rolled, outputIndex: 0n }], outputs }));

  const { anchorChain } = builder.resolveCalls[0];
  assertEquals(anchorChain.length, 2);
  assertEquals(anchorChain[0].payload.outputs, outputs);
  assertEquals(anchorChain[0].aggregates, [{ block: rolled, outputCount: 9n }]);
  assertEquals(anchorChain[1], builder.anchor);
});

Deno.test('claims resolve before refs and keep their order', () => {
  const builder = new StubBuilder();
  const a = fakeBlock('a', [out(1n)]);
  const b = fakeBlock('b', [out(1n)]);
  const c = fakeBlock('c', [out(1n)]);

  const built = okPayload(builder.build(payload({
    claims: [{ producer: a, outputIndex: 0n }, { producer: b, outputIndex: 0n }],
    refs: [{ producer: c, outputIndex: 0n }],
    outputs: [out(2n)],
  })));

  assertEquals(built.claims, [100n, 200n]);
  assertEquals(built.refs, [300n]);
  assertEquals(builder.resolveCalls.map((x) => x.outputBlock), [a, b, c]);
});

Deno.test('the built timestamp should be >= the anchor timestamp', () => {
  const builder = new StubBuilder();
  builder.anchor.payload.timestampMs = 5_000;

  const built = okPayload(builder.build(payload({ outputs: [out(0n)] })));

  assertEquals(built.timestampMs >= 5_000, true, `timestamp ${built.timestampMs} predates anchor`);
});

const genesisOf = (ctx: Context): Block =>
  ctx.get(BlockStore).ingest({
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw: ctx.config.genesis,
  });

const ingestBlock = (ctx: Context, attrs: Partial<BlockPayload>): Block =>
  ctx.get(BlockStore).ingest({
    source: AtomSource.Local,
    receivedAt: 0,
    raw: ctx.get(AtomSerializer).serialize(AtomType.Block, {
      anchor: ZERO_HASH,
      chain: [],
      aggregates: [],
      claims: [],
      refs: [],
      outputs: [],
      timestampMs: 0,
      ...attrs,
    }),
  });

Deno.test('a claim on the anchor resolves past the draft outputs', () => {
  const ctx = makeTestContext();
  const genesis = genesisOf(ctx);
  const outputs = [out(600_000n), out(400_000n)];

  const built = okPayload(
    ctx.get(BlockBuilder).build(payload({
      claims: [{ producer: genesis, outputIndex: 0n }],
      outputs,
    })),
  );

  assertEquals(built.anchor, genesis.hash);
  // wp 4.5: own outputs occupy [0, 2), so the anchor's output 0 sits at 2.
  assertEquals(built.claims, [2n]);
});

Deno.test('a built claim index round-trips back to the claimed output', () => {
  const ctx = makeTestContext();
  const genesis = genesisOf(ctx);

  const built = okPayload(
    ctx.get(BlockBuilder).build(payload({
      claims: [{ producer: genesis, outputIndex: 0n }],
      outputs: [out(1_000_000n)],
    })),
  );

  const block = ctx.get(BlockStore).ingest({
    source: AtomSource.Local,
    receivedAt: 0,
    raw: ctx.get(AtomSerializer).serialize(AtomType.Block, built),
  });

  assertEquals(block.claims.length, 1);
  assertEquals(block.claims[0].resolved, true);
  assertEquals(block.claims[0].producer, genesis);
  assertEquals(block.claims[0].outputIdx, 0n);
});

Deno.test('a DRAFT_SELF claim resolves to a bare draft output index', () => {
  const ctx = makeTestContext();
  genesisOf(ctx);

  const built = okPayload(
    ctx.get(BlockBuilder).build(payload({
      claims: [{ producer: DRAFT_SELF, outputIndex: 1n }],
      outputs: [out(0n), out(0n), out(0n)],
    })),
  );

  assertEquals(built.claims, [1n]);
});

Deno.test('a DRAFT_SELF claim past the draft outputs is rejected', () => {
  const ctx = makeTestContext();
  genesisOf(ctx);

  assertThrows(() =>
    ctx.get(BlockBuilder).build(payload({
      claims: [{ producer: DRAFT_SELF, outputIndex: 2n }],
      outputs: [out(1n), out(2n)],
    }))
  );
});

// TODO: Fix the throughput (currently hardcoded to 0)
Deno.test.ignore('the built chain throughput ignores what the block claims', () => {
  const ctx = makeTestContext({ funding: { alice: 1_000_000n } });
  const genesis = genesisOf(ctx);

  const built = okPayload(
    ctx.get(BlockBuilder).build(payload({
      claims: [{ producer: genesis, outputIndex: 0n }],
      outputs: [out(1_000_000n)],
    })),
  );

  assertEquals(built.chain[0].throughput, 1_000_000n);
});

Deno.test('building an aggregation cannot resolve its own aggregate claim', () => {
  const ctx = makeTestContext();
  const genesis = genesisOf(ctx);
  const rolled = ingestBlock(ctx, {
    anchor: genesis.hash,
    outputs: [aggregationOut(10n)],
  });

  const built = okPayload(
    ctx.get(BlockBuilder).build(payload({
      claims: [{ producer: rolled, outputIndex: 0n }],
      outputs: [out(10n)],
    })),
  );

  assertEquals(built.aggregates, [{ block: rolled.hash, outputCount: 1n }]);
  assertEquals(built.claims, [1n]);
});
