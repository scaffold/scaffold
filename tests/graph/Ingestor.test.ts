import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';
import { Context } from '../../src/Context.ts';
import { AtomSerializer } from '../../src/graph/AtomSerializer.ts';
import { BlockStore } from '../../src/graph/BlockStore.ts';
import { BlockIngestor, serializeBlock } from '../../src/graph/Ingestor.ts';
import {
  AtomSource,
  AtomType,
  Block,
  BLOCK_REF_TYPE,
  BlockAction,
  BlockActionType,
  BlockPayload,
  BlockRef,
  isBlockPayload,
  Output,
  OutputResolverType,
  ResolvingClaim,
} from '../../src/graph/types.ts';
import { bin2str, str2bin } from '../../src/util/buffer.ts';
import { Hash, ZERO_HASH } from '../../src/util/Hash.ts';
import { taggedParse, taggedStringify } from '../../src/util/json.ts';
import { makeTestContext, testPublicKey } from '../helpers/v2.ts';

const output = (amount: bigint, body?: Uint8Array): Output =>
  body === undefined
    ? { contract: ZERO_HASH, params: testPublicKey('bob'), amount }
    : { contract: ZERO_HASH, params: testPublicKey('bob'), body, amount };

const blockPayload = (over: Partial<BlockPayload> = {}): BlockPayload => ({
  anchor: ZERO_HASH,
  chain: [],
  aggregates: [],
  claims: [],
  refs: [],
  outputs: [],
  timestampMs: 0,
  ...over,
});

const richPayload = (anchor: Hash, aggregate: Hash) =>
  blockPayload({
    anchor,
    chain: [{ weight: 50n, throughput: 12n }, { weight: 17n, throughput: 5n }],
    aggregates: [{ block: aggregate, outputCount: 4n }],
    claims: [1n, 2n],
    refs: [3n],
    outputs: [output(7n), output(0n, new Uint8Array([1, 2, 3]))],
    timestampMs: 1_700_000_000_123,
  });

interface Fixture {
  ctx: Context;
  store: BlockStore;
  genesis: Block;
  build(payload: BlockPayload): { raw: Uint8Array; hash: Hash };
  put(built: { raw: Uint8Array }): Block;
  add(payload: BlockPayload): Block;
}

function setup(): Fixture {
  const ctx = makeTestContext();
  const store = ctx.get(BlockStore);
  const serializer = ctx.get(AtomSerializer);
  let receivedAt = 0;

  const build = (payload: BlockPayload) => {
    const raw = serializer.serialize(AtomType.Block, payload);
    return { raw, hash: Hash.digest(raw) };
  };
  const put = ({ raw }: { raw: Uint8Array }) =>
    store.ingest({ source: AtomSource.Remote, receivedAt: ++receivedAt, raw });

  const genesis = store.ingest({
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw: ctx.config.genesis,
  });

  return { ctx, store, genesis, build, put, add: (payload) => put(build(payload)) };
}

const record = (target: { listeners: Set<(a: BlockAction) => void> }) => {
  const actions: BlockAction[] = [];
  target.listeners.add((action) => actions.push(action));
  return actions;
};

// -- serializeBlock -------------------------------------------------

Deno.test('serializeBlock round-trips every wire-typed field', () => {
  const payload = richPayload(Hash.digest('anchor'), Hash.digest('aggregate'));
  const bytes = serializeBlock(payload, (size) => new Uint8Array(size));

  const parsed = taggedParse(bin2str(bytes));
  assert(isBlockPayload(parsed));
  assertEquals(parsed, payload);
});

Deno.test('serializeBlock asks the allocator for exactly the encoded length', () => {
  const payload = richPayload(Hash.digest('anchor'), Hash.digest('aggregate'));
  const expected = str2bin(taggedStringify(payload));

  const sizes: number[] = [];
  const buf = new Uint8Array(expected.byteLength);
  const returned = serializeBlock(payload, (size) => {
    sizes.push(size);
    return buf;
  });

  assertEquals(sizes, [expected.byteLength]);
  assertStrictEquals(returned, buf);
  assertEquals(buf, expected);
});

Deno.test('serializeBlock writes through a subarray of a larger buffer', () => {
  const payload = blockPayload({ outputs: [output(1n)] });
  const expected = str2bin(taggedStringify(payload));
  const offset = 4;

  let outer: Uint8Array | undefined;
  serializeBlock(payload, (size) => {
    outer = new Uint8Array(offset + size + 65);
    return outer.subarray(offset, offset + size);
  });

  assertEquals(outer!.subarray(offset, offset + expected.byteLength), expected);
});

Deno.test('serializeBlock rejects an allocator that returns the wrong size', () => {
  const payload = blockPayload();
  assertThrows(() => serializeBlock(payload, (size) => new Uint8Array(size + 1)));
  assertThrows(() => serializeBlock(payload, (size) => new Uint8Array(size - 1)));
  assertThrows(() => serializeBlock(payload, () => new Uint8Array(0)));
});

Deno.test('BlockIngestor.serialize is serializeBlock', () => {
  const { ctx } = setup();
  const payload = richPayload(Hash.digest('anchor'), Hash.digest('aggregate'));
  const alloc = (size: number) => new Uint8Array(size);

  assertEquals(
    new BlockIngestor(ctx).serialize(payload, alloc),
    serializeBlock(payload, alloc),
  );
});

// -- isBlockPayload -------------------------------------------------

Deno.test('isBlockPayload accepts the genesis shape and a fully populated block', () => {
  assert(isBlockPayload(blockPayload()));
  assert(isBlockPayload(richPayload(Hash.digest('a'), Hash.digest('b'))));
});

Deno.test('isBlockPayload rejects a payload missing any field', () => {
  for (const key of Object.keys(blockPayload())) {
    const payload = blockPayload() as unknown as Record<string, unknown>;
    delete payload[key];
    assertFalse(isBlockPayload(payload), `missing ${key} was accepted`);
  }
});

Deno.test('isBlockPayload rejects unknown keys at every level', () => {
  assertFalse(isBlockPayload({ ...blockPayload(), declaredWeight: 1n }));
  assertFalse(
    isBlockPayload(blockPayload({ chain: [{ weight: 1n, throughput: 1n, x: 1n } as never] })),
  );
  assertFalse(
    isBlockPayload(
      blockPayload({ aggregates: [{ block: ZERO_HASH, outputCount: 1n, x: 1n } as never] }),
    ),
  );
  assertFalse(
    isBlockPayload(blockPayload({ outputs: [{ ...output(1n), stalling: true } as never] })),
  );
});

Deno.test('isBlockPayload rejects wire-lookalike types', () => {
  assertFalse(isBlockPayload(blockPayload({ anchor: ZERO_HASH.toHex() as never })));
  assertFalse(isBlockPayload(blockPayload({ anchor: ZERO_HASH.toBytes() as never })));
  assertFalse(isBlockPayload(blockPayload({ claims: [0 as never] })));
  assertFalse(isBlockPayload(blockPayload({ refs: ['0' as never] })));
  assertFalse(isBlockPayload(blockPayload({ outputs: [{ ...output(1n), amount: 1 as never }] })));
  assertFalse(
    isBlockPayload(blockPayload({ outputs: [{ ...output(1n), params: 'ab' as never }] })),
  );
  assertFalse(isBlockPayload(blockPayload({ outputs: [{ ...output(1n), body: null as never }] })));
  assertFalse(
    isBlockPayload(blockPayload({ aggregates: [{ block: ZERO_HASH, outputCount: 1 as never }] })),
  );
});

Deno.test('isBlockPayload rejects non-arrays where lists are required', () => {
  assertFalse(isBlockPayload(blockPayload({ claims: {} as never })));
  assertFalse(isBlockPayload(blockPayload({ refs: 0n as never })));
  assertFalse(isBlockPayload(blockPayload({ outputs: output(1n) as never })));
  assertFalse(isBlockPayload(blockPayload({ aggregates: null as never })));
  assertFalse(isBlockPayload(blockPayload({ chain: 'x' as never })));
});

Deno.test('isBlockPayload rejects non-payload values', () => {
  for (
    const val of [undefined, null, 0, '', 'block', true, [], [blockPayload()], new Uint8Array()]
  ) {
    assertFalse(isBlockPayload(val), `${String(val)} was accepted`);
  }
});

Deno.test('isBlockPayload requires a finite numeric timestamp', () => {
  assert(isBlockPayload(blockPayload({ timestampMs: -1 })));
  for (const timestampMs of [NaN, Infinity, -Infinity]) {
    assertFalse(isBlockPayload(blockPayload({ timestampMs })));
  }
  assertFalse(isBlockPayload(blockPayload({ timestampMs: 0n as never })));
  assertFalse(isBlockPayload(blockPayload({ timestampMs: '0' as never })));
});

// Non-finite timestamps stringify to `null`, so they never reach the decoder as numbers.
Deno.test('a non-finite timestamp cannot survive the wire', () => {
  for (const timestampMs of [NaN, Infinity, -Infinity]) {
    const decoded = taggedParse(taggedStringify(blockPayload({ timestampMs }))) as BlockPayload;
    assertEquals(decoded.timestampMs, null as never);
    assertFalse(isBlockPayload(decoded));
  }
});

// -- deserialize: atom base ----------------------------------------

Deno.test('deserialize preserves the atom base and recovers the author', () => {
  const { genesis, build, put } = setup();
  const built = build(blockPayload({ anchor: genesis.hash, outputs: [output(2n)] }));
  const block = put(built);

  assertEquals(block.type, AtomType.Block);
  assertEquals(block.source, AtomSource.Remote);
  assertEquals(block.hash.toHex(), built.hash.toHex());
  assertStrictEquals(block.raw, built.raw);
  assertEquals(block.payload.outputs[0].amount, 2n);
  assertEquals(block.signer, testPublicKey('alice'));
  assert(block.signature !== undefined);
  assertEquals(taggedParse(bin2str(block.message)), block.payload);
});

Deno.test('deserialize rejects a signed message that is not a block payload', () => {
  const { ctx, store } = setup();
  const raw = ctx.get(AtomSerializer).serialize(
    AtomType.Block,
    { ...blockPayload(), junk: 1n } as unknown as BlockPayload,
  );

  assertThrows(
    () => store.ingest({ source: AtomSource.Remote, receivedAt: 1, raw }),
    Error,
    'Not a block',
  );
});

// -- deserialize: anchors (wp 4.2) ---------------------------------

Deno.test('a ZERO_HASH anchor means no anchor', () => {
  const { store, genesis } = setup();

  assertEquals(genesis.anchor, undefined);
  assertEquals(store.get(ZERO_HASH).anchoringNodes, []);
});

Deno.test('a known anchor resolves to the block and back-links', () => {
  const { genesis, add } = setup();
  const child = add(blockPayload({ anchor: genesis.hash, outputs: [output(1n)] }));

  assertStrictEquals(child.anchor, genesis);
  assertEquals(genesis.anchoringNodes, [child]);
  assertEquals(child.anchoringNodes, []);
});

Deno.test('an unknown anchor resolves to one shared BlockRef', () => {
  const { store, add } = setup();
  const missing = Hash.digest('missing-anchor');

  const a = add(blockPayload({ anchor: missing, outputs: [output(1n)] }));
  const b = add(blockPayload({ anchor: missing, outputs: [output(2n)] }));
  const ref = store.get(missing);

  assertEquals(ref.type, BLOCK_REF_TYPE);
  assertStrictEquals(a.anchor, ref);
  assertStrictEquals(b.anchor, ref);
  assertEquals(ref.anchoringNodes, [a, b]);
});

// -- deserialize: aggregation (wp 4.3) -----------------------------

Deno.test('aggregates resolve through the store and back-link with their outputCount', () => {
  const { store, genesis, add } = setup();
  const known = add(blockPayload({ anchor: genesis.hash, outputs: [output(1n), output(2n)] }));
  const missing = Hash.digest('missing-aggregate');

  const aggregator = add(blockPayload({
    anchor: genesis.hash,
    aggregates: [{ block: known.hash, outputCount: 2n }, { block: missing, outputCount: 9n }],
    outputs: [output(3n)],
  }));

  assertStrictEquals(aggregator.aggregates[0].block, known);
  assertStrictEquals(aggregator.aggregates[1].block, store.get(missing));
  assertEquals(aggregator.aggregates.map((x) => x.outputCount), [2n, 9n]);
  assertEquals(known.aggregatingNodes, [aggregator]);
  assertEquals(store.get(missing).aggregatingNodes, [aggregator]);
});

// -- deserialize: claims and refs (wp 4.5, 4.7) --------------------

Deno.test('a claim registers on the producing block at the resolved index', () => {
  const { genesis, add } = setup();
  const claimer = add(blockPayload({
    anchor: genesis.hash,
    claims: [1n],
    outputs: [output(1n)],
  }));

  const claim = claimer.claims[0];
  assertEquals(claimer.claims.length, 1);
  assertEquals(claim.type, OutputResolverType.Claim);
  assertStrictEquals(claim.claimer, claimer);
  assertEquals(claim.claimIdx, 0);
  assertStrictEquals(claim.producer, genesis);
  assertEquals(claim.outputIdx, 0n);
  assert(claim.resolved);
  assertEquals(genesis.resolvingOutputs.get(0n), [claim]);
  assertEquals(claimer.resolvingOutputs.size, 0);
});

Deno.test('a ref registers alongside claims on the same output', () => {
  const { genesis, add } = setup();
  const reffer = add(blockPayload({
    anchor: genesis.hash,
    claims: [1n],
    refs: [1n],
    outputs: [output(1n)],
  }));

  const [claim] = reffer.claims;
  const [ref] = reffer.refs;
  assertEquals(ref.type, OutputResolverType.Ref);
  assertStrictEquals(ref.reffer, reffer);
  assertEquals(ref.refIdx, 0);
  assertStrictEquals(ref.producer, genesis);
  assertEquals(ref.outputIdx, 0n);
  assertEquals(genesis.resolvingOutputs.get(0n), [claim, ref]);
});

Deno.test('a self-claim resolves to the claiming block', () => {
  const { genesis, add } = setup();
  const block = add(blockPayload({
    anchor: genesis.hash,
    claims: [0n],
    refs: [1n],
    outputs: [output(1n), output(2n)],
  }));

  assertStrictEquals(block.claims[0].producer, block);
  assertEquals(block.claims[0].outputIdx, 0n);
  assert(block.claims[0].resolved);
  assertStrictEquals(block.refs[0].producer, block);
  assertEquals(block.refs[0].outputIdx, 1n);
  assertEquals(block.resolvingOutputs.get(0n), [block.claims[0]]);
  assertEquals(block.resolvingOutputs.get(1n), [block.refs[0]]);
});

// wp 4.5: own outputs, then aggregates in reverse order, then the anchor.
Deno.test('claim indices walk own outputs, then reversed aggregates, then the anchor', () => {
  const { genesis, add } = setup();
  const first = add(blockPayload({ anchor: genesis.hash, outputs: [output(1n)] }));
  const second = add(blockPayload({ anchor: genesis.hash, outputs: [output(2n)] }));

  const block = add(blockPayload({
    anchor: genesis.hash,
    aggregates: [{ block: first.hash, outputCount: 1n }, { block: second.hash, outputCount: 1n }],
    claims: [0n, 1n, 2n, 3n],
    outputs: [output(3n)],
  }));

  assertEquals(
    block.claims.map((c) => [(c.producer as Block).hash.toHex(), c.outputIdx]),
    [
      [block.hash.toHex(), 0n],
      [second.hash.toHex(), 0n],
      [first.hash.toHex(), 0n],
      [genesis.hash.toHex(), 0n],
    ],
  );
  assert(block.claims.every((c) => c.resolved));
});

Deno.test('a claim into an unknown aggregate parks unresolved on the BlockRef', () => {
  const { store, genesis, add } = setup();
  const missing = Hash.digest('missing-subtree');

  const block = add(blockPayload({
    anchor: genesis.hash,
    aggregates: [{ block: missing, outputCount: 5n }],
    claims: [3n],
    outputs: [output(1n)],
  }));

  const ref = store.get(missing);
  const claim = block.claims[0];
  assertStrictEquals(claim.producer, ref);
  assertEquals(claim.outputIdx, 2n);
  assertFalse(claim.resolved);
  assertEquals(ref.resolvingOutputs.get(2n), [claim]);
});

Deno.test('a claim past the end of the output space is rejected', () => {
  const { store, ctx } = setup();
  const raw = ctx.get(AtomSerializer).serialize(
    AtomType.Block,
    blockPayload({ claims: [1n], outputs: [output(1n)] }),
  );

  assertThrows(
    () => store.ingest({ source: AtomSource.Remote, receivedAt: 1, raw }),
    Error,
    'Claim index out of bounds',
  );
});

// -- deserialize: BlockRef promotion -------------------------------

interface Promotion {
  fixture: Fixture;
  ref: BlockRef;
  anchoring: Block[];
  aggregating: Block;
  promote(): Block;
}

// A block whose hash is referenced as an anchor, as an aggregate, and as the
// producer of both a claim and a ref -- every way a ref can be pointed at.
function pendingBlock(): Promotion {
  const fixture = setup();
  const { store, genesis, build, put, add } = fixture;

  const target = build(blockPayload({
    anchor: genesis.hash,
    claims: [3n],
    outputs: [output(1n), output(2n), output(3n)],
    timestampMs: 10,
  }));

  const anchoring = [
    add(blockPayload({ anchor: target.hash, outputs: [output(1n)] })),
    add(blockPayload({ anchor: target.hash, outputs: [output(2n)] })),
  ];
  const aggregating = add(blockPayload({
    anchor: target.hash,
    aggregates: [{ block: target.hash, outputCount: 3n }],
    claims: [2n],
    refs: [3n],
    outputs: [output(4n)],
  }));

  const ref = store.get(target.hash) as BlockRef;
  assertEquals(ref.type, BLOCK_REF_TYPE);

  return { fixture, ref, anchoring, aggregating, promote: () => put(target) };
}

Deno.test('promotion replaces the ref everywhere it was referenced', () => {
  const { fixture, ref, anchoring, aggregating, promote } = pendingBlock();

  assertEquals(ref.resolvingOutputs.get(1n), [aggregating.claims[0]]);
  assertEquals(ref.resolvingOutputs.get(2n), [aggregating.refs[0]]);
  assertFalse(aggregating.claims[0].resolved);

  const block = promote();

  assertStrictEquals(fixture.store.get(block.hash), block);
  assertEquals(anchoring.map((x) => x.anchor), [block, block]);
  assertEquals(block.anchoringNodes, [...anchoring, aggregating]);
  assertStrictEquals(aggregating.aggregates[0].block, block);
  assertEquals(block.aggregatingNodes, [aggregating]);

  assertStrictEquals(aggregating.claims[0].producer, block);
  assertEquals(aggregating.claims[0].outputIdx, 1n);
  assert(aggregating.claims[0].resolved);
  assertStrictEquals(aggregating.refs[0].producer, block);
  assertEquals(aggregating.refs[0].outputIdx, 2n);
  assertEquals(block.resolvingOutputs.get(1n), [aggregating.claims[0]]);
  assertEquals(block.resolvingOutputs.get(2n), [aggregating.refs[0]]);
});

Deno.test('promotion keeps the promoted block wired to its own graph', () => {
  const { fixture, promote } = pendingBlock();
  const block = promote();

  assertStrictEquals(block.anchor, fixture.genesis);
  assertEquals(fixture.genesis.anchoringNodes.at(-1), block);
  assertStrictEquals(block.claims[0].producer, fixture.genesis);
  assertEquals(block.claims[0].outputIdx, 0n);
});

Deno.test('promotion carries the ref listeners onto the block', () => {
  const { ref, promote } = pendingBlock();
  const listener = () => {};
  ref.listeners.add(listener);

  const block = promote();

  assertStrictEquals(block.listeners, ref.listeners);
  assert(block.listeners.has(listener));
});

Deno.test('promotion announces newly resolved claims to both sides', () => {
  const { ref, aggregating, promote } = pendingBlock();
  const producerActions = record(ref);
  const claimerActions = record(aggregating);

  promote();

  assertArrayIncludes(producerActions, [{
    type: BlockActionType.LinkClaimingNode,
    claim: aggregating.claims[0],
  }]);
  assertArrayIncludes(claimerActions, [{
    type: BlockActionType.LinkClaim,
    claim: aggregating.claims[0],
  }]);
});

Deno.test('promotion re-parks a claim that resolves past the promoted block', () => {
  const { store, genesis, build, put, add } = setup();
  const missing = Hash.digest('deeper-missing');

  const target = build(blockPayload({
    anchor: genesis.hash,
    aggregates: [{ block: missing, outputCount: 4n }],
    outputs: [output(1n)],
  }));
  const claimer = add(blockPayload({
    anchor: genesis.hash,
    aggregates: [{ block: target.hash, outputCount: 5n }],
    claims: [3n],
    outputs: [output(1n)],
  }));
  assertStrictEquals(claimer.claims[0].producer, store.get(target.hash));

  const block = put(target);

  assertStrictEquals(claimer.claims[0].producer, store.get(missing));
  assertEquals(claimer.claims[0].outputIdx, 1n);
  assertFalse(claimer.claims[0].resolved);
  assertEquals(store.get(missing).resolvingOutputs.get(1n), [claimer.claims[0]]);
  assertEquals(block.resolvingOutputs.size, 0);
});

// The resolved claim graph is a function of the block set, not of arrival order.
Deno.test('claim resolution is independent of ingestion order', () => {
  const summarise = (order: 'producer-first' | 'claimer-first') => {
    const { genesis, build, put } = setup();
    const producer = build(blockPayload({
      anchor: genesis.hash,
      outputs: [output(1n), output(2n)],
      timestampMs: 5,
    }));
    const claimer = build(blockPayload({
      anchor: genesis.hash,
      aggregates: [{ block: producer.hash, outputCount: 2n }],
      claims: [2n],
      refs: [1n],
      outputs: [output(3n)],
      timestampMs: 6,
    }));

    let producerBlock: Block;
    let claimerBlock: Block;
    if (order === 'producer-first') {
      producerBlock = put(producer);
      claimerBlock = put(claimer);
    } else {
      claimerBlock = put(claimer);
      producerBlock = put(producer);
    }

    const describe = (r: { producer: Block | BlockRef; outputIdx: bigint; resolved: boolean }) => ({
      producer: r.producer.hash.toHex(),
      outputIdx: r.outputIdx,
      resolved: r.resolved,
    });

    return {
      claims: claimerBlock.claims.map(describe),
      refs: claimerBlock.refs.map(describe),
      registered: [...producerBlock.resolvingOutputs].map(([k, v]) => [k, v.length]),
      aggregatingNodes: producerBlock.aggregatingNodes.map((b) => b.hash.toHex()),
      aggregate: (claimerBlock.aggregates[0].block as Block).hash.toHex(),
    };
  };

  assertEquals(summarise('claimer-first'), summarise('producer-first'));
});

// -- ingest --------------------------------------------------------
//
// `BlockIngestor.ingest` is currently unreachable: `BlockStore.ingest` only ever
// gets as far as `deserialize`, so no BlockAction is emitted on the real ingestion
// path. These call `ingest` directly and exercise the method in isolation.

Deno.test('ingest links a block to its anchor in both directions', () => {
  const { ctx, genesis, add } = setup();
  const child = add(blockPayload({ anchor: genesis.hash, outputs: [output(1n)] }));
  const grandchild = add(blockPayload({ anchor: child.hash, outputs: [output(2n)] }));

  const anchorActions = record(genesis);
  const selfActions = record(child);
  const anchoringActions = record(grandchild);

  new BlockIngestor(ctx).ingest(child);

  assertEquals(anchorActions, [{ type: BlockActionType.LinkAnchoringNode, anchoringNode: child }]);
  assertEquals(anchoringActions, [{ type: BlockActionType.LinkAnchor, anchor: child }]);
  assertEquals(selfActions, []);
});

Deno.test('ingest links a block to its aggregates in both directions', () => {
  const { ctx, genesis, add } = setup();
  const first = add(blockPayload({ anchor: genesis.hash, outputs: [output(1n)] }));
  const second = add(blockPayload({ anchor: genesis.hash, outputs: [output(2n)] }));
  const block = add(blockPayload({
    anchor: genesis.hash,
    aggregates: [{ block: first.hash, outputCount: 1n }, { block: second.hash, outputCount: 1n }],
    outputs: [output(3n)],
  }));
  const aggregator = add(blockPayload({
    anchor: genesis.hash,
    aggregates: [{ block: block.hash, outputCount: 3n }],
    outputs: [output(4n)],
  }));

  const firstActions = record(first);
  const secondActions = record(second);
  const aggregatorActions = record(aggregator);

  new BlockIngestor(ctx).ingest(block);

  assertEquals(firstActions, [
    { type: BlockActionType.LinkAggregatingNode, aggregatingNode: block, index: 0 },
  ]);
  assertEquals(secondActions, [
    { type: BlockActionType.LinkAggregatingNode, aggregatingNode: block, index: 1 },
  ]);
  assertEquals(aggregatorActions, [
    { type: BlockActionType.LinkAggregate, aggregate: block, index: 0 },
  ]);
});

// Either arrival order has to tell the producer: `deserialize`'s ref-relink path covers
// the producer arriving last, this covers the claimer arriving last.
Deno.test('ingest tells a producer that its output was claimed', () => {
  const { ctx, genesis, add } = setup();

  const claimed: ResolvingClaim[] = [];
  genesis.listeners.add((action) => {
    if (action.type === BlockActionType.LinkClaimingNode) claimed.push(action.claim);
  });

  const claimer = add(blockPayload({
    anchor: genesis.hash,
    claims: [1n],
    outputs: [output(1n)],
  }));
  new BlockIngestor(ctx).ingest(claimer);

  assertEquals(claimed.length, 1, 'the producer was never told its output was claimed');
  assertStrictEquals(claimed[0], claimer.claims[0]);
});
