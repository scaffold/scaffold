import { assert, assertEquals, assertThrows } from '@std/assert';
import { AnchorChainNode, ClaimIndexService } from '../src/core/ClaimIndexService.ts';
import { BROKEN_ANCHOR_CHAIN, ForestService } from '../src/core/ForestService.ts';
import {
  AtomSource,
  AtomType,
  Block,
  BLOCK_REF_TYPE,
  BlockRef,
  Output,
  OutputResolverType,
  ResolvingClaim,
  ResolvingRef,
} from '../src/core/types.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { makeTestContext } from './helpers/v2.ts';

const ctx = makeTestContext();
const claimIndex = ctx.get(ClaimIndexService);
const forest = ctx.get(ForestService);

// -- Fixtures ----------------------------------------------------------------

/** The new block anchors at `anchor` and aggregates each of `children`. */
function mkBlock(
  name: string,
  outputCount: number,
  anchor?: Block | BlockRef,
  ...children: Block[]
): Block {
  const outputs: Output[] = Array.from({ length: outputCount }, (_, i) => ({
    contract: Hash.digest(`${name}#${i}`),
    params: new Uint8Array(),
    amount: 1n,
  }));
  const self: Block = {
    hash: Hash.digest(name),
    type: AtomType.Block,
    source: AtomSource.Local,
    receivedAt: 0,
    raw: new Uint8Array(),
    message: new Uint8Array(),
    fromConnections: [],
    toConnections: new Set(),
    payload: {
      anchor: anchor?.hash ?? ZERO_HASH,
      chain: [],
      aggregates: [],
      claims: [],
      refs: [],
      outputs,
      timestampMs: 0,
    },
    anchor,
    aggregates: [],
    claims: [],
    refs: [],
    anchoringNodes: [],
    aggregatingNodes: [],
    resolvingOutputs: new Map(),
    listeners: new Set(),
  };

  anchor?.anchoringNodes.push(self);

  for (const child of children) {
    const outputCount = subtreeOutputs(child);
    self.aggregates.push({ block: child, outputCount });
    self.payload.aggregates.push({ block: child.hash, outputCount });
    child.aggregatingNodes.push(self);
  }

  return self;
}

function mkRef(name: string): BlockRef {
  return {
    hash: Hash.digest(name),
    type: BLOCK_REF_TYPE,
    connections: [],
    anchoringNodes: [],
    aggregatingNodes: [],
    resolvingOutputs: new Map(),
    listeners: new Set(),
  };
}

// wp 4.3: outputCount is the aggregate's own output count plus every one of its
// aggregates' outputCount.
function subtreeOutputs(block: Block): bigint {
  let count = BigInt(block.payload.outputs.length);
  for (const agg of block.aggregates) count += agg.outputCount;
  return count;
}

function aggregateRef(parent: Block, child: BlockRef, outputCount: bigint): Block {
  parent.aggregates.push({ block: child, outputCount });
  parent.payload.aggregates.push({ block: child.hash, outputCount });
  child.aggregatingNodes.push(parent);
  return parent;
}

function mkClaim(claimer: Block, producer: Block | BlockRef, outputIdx: bigint): ResolvingClaim {
  return {
    type: OutputResolverType.Claim,
    producer,
    outputIdx,
    claimer,
    claimIdx: 0,
    resolved: false,
  };
}

function mkRefResolver(reffer: Block, producer: Block | BlockRef, outputIdx: bigint): ResolvingRef {
  return {
    type: OutputResolverType.Ref,
    producer,
    outputIdx,
    reffer,
    refIdx: 0,
    resolved: false,
  };
}

// -- Reference model, transcribed from whitepaper 4.5 ------------------------

interface SpaceEntry {
  block: Block;
  outputIndex: bigint;
}

function treeSpace(block: Block): SpaceEntry[] {
  const space: SpaceEntry[] = block.payload.outputs.map((_, i) => ({
    block,
    outputIndex: BigInt(i),
  }));
  for (const agg of block.aggregates.toReversed()) {
    assert(agg.block.type === AtomType.Block);
    space.push(...treeSpace(agg.block));
  }
  return space;
}

function outputSpace(block: Block): SpaceEntry[] {
  const space = treeSpace(block);
  if (block.anchor !== undefined) {
    assert(block.anchor.type === AtomType.Block);
    space.push(...outputSpace(block.anchor));
  }
  return space;
}

function anchorChainOf(block: Block): Block[] {
  const chain = forest.anchorChain(block);
  assert(chain !== BROKEN_ANCHOR_CHAIN);
  return chain;
}

function describe(entry: SpaceEntry): string {
  return `${entry.block.hash.toHex().slice(0, 4)}#${entry.outputIndex}`;
}

/**
 * G <- A <- B <- C by anchoring. Trees (by aggregation):
 *   A: [A0, A1]        B: [B0], B0: [B00, B01]        C: [C0, C1], C1: [C10]
 */
function makeForest() {
  const G = mkBlock('G', 3);
  const A0 = mkBlock('A0', 2, G);
  const A1 = mkBlock('A1', 1, G);
  const A = mkBlock('A', 1, G, A0, A1);
  const B00 = mkBlock('B00', 1, A);
  const B01 = mkBlock('B01', 2, A);
  const B0 = mkBlock('B0', 1, A, B00, B01);
  const B = mkBlock('B', 2, A, B0);
  const C0 = mkBlock('C0', 1, B);
  const C10 = mkBlock('C10', 2, B);
  const C1 = mkBlock('C1', 3, B, C10);
  const C = mkBlock('C', 2, B, C0, C1);

  return { G, A, A0, A1, B, B0, B00, B01, C, C0, C1, C10 };
}

// -- countOutputs ------------------------------------------------------------

Deno.test('countOutputs with no argument is the size of the block tree space', () => {
  const f = makeForest();
  for (const block of Object.values(f)) {
    assertEquals(claimIndex.countOutputs(block), BigInt(treeSpace(block).length));
  }
});

Deno.test('countOutputs(block, k) is where aggregate k starts in the tree space', () => {
  const f = makeForest();
  for (const block of Object.values(f)) {
    const space = treeSpace(block);
    for (let k = 0; k < block.aggregates.length; k++) {
      const child = block.aggregates[k].block;
      const start = space.findIndex((entry) => entry.block === child);
      assertEquals(
        claimIndex.countOutputs(block, k),
        BigInt(start),
        `${block.hash.toHex().slice(0, 4)} aggregate ${k}`,
      );
    }
  }
});

Deno.test('countOutputs on the last aggregate is just the block own outputs', () => {
  const f = makeForest();
  // wp 4.5: aggregates are traversed in reverse, so the last one sits directly
  // after the block's own outputs.
  assertEquals(claimIndex.countOutputs(f.C, f.C.aggregates.length - 1), 2n);
  assertEquals(claimIndex.countOutputs(f.A, f.A.aggregates.length - 1), 1n);
});

Deno.test('countOutputs on a leaf block is its output count', () => {
  const f = makeForest();
  assertEquals(claimIndex.countOutputs(f.G), 3n);
  assertEquals(claimIndex.countOutputs(f.A0), 2n);
  assertEquals(claimIndex.countOutputs(f.C10), 2n);
});

Deno.test('countOutputs sums an aggregate declared as a ref', () => {
  const parent = mkBlock('P', 2);
  aggregateRef(parent, mkRef('R'), 7n);
  assertEquals(claimIndex.countOutputs(parent), 9n);
  assertEquals(claimIndex.countOutputs(parent, 0), 2n);
});

// -- The output space layout -------------------------------------------------

Deno.test('the output space matches the whitepaper 4.5 layout', () => {
  const f = makeForest();
  assertEquals(
    outputSpace(f.C).map(describe),
    [
      'C#0',
      'C#1',
      'C1#0',
      'C1#1',
      'C1#2',
      'C10#0',
      'C10#1',
      'C0#0',
      'B#0',
      'B#1',
      'B0#0',
      'B01#0',
      'B01#1',
      'B00#0',
      'A#0',
      'A1#0',
      'A0#0',
      'A0#1',
      'G#0',
      'G#1',
      'G#2',
    ].map((name) => `${Hash.digest(name.split('#')[0]).toHex().slice(0, 4)}#${name.split('#')[1]}`),
  );
});

// -- propagateClaim ----------------------------------------------------------

Deno.test('propagateClaim resolves every index of the output space', () => {
  const f = makeForest();
  const space = outputSpace(f.C);
  for (let i = 0; i < space.length; i++) {
    const claim = mkClaim(f.C, f.C, BigInt(i));
    claimIndex.propagateClaim(claim);
    assertEquals(claim.resolved, true, `index ${i}`);
    assertEquals(claim.producer, space[i].block, `index ${i}`);
    assertEquals(claim.outputIdx, space[i].outputIndex, `index ${i}`);
  }
});

Deno.test('propagateClaim resolves the output space of every anchor chain member', () => {
  const f = makeForest();
  for (const start of [f.C, f.B, f.A, f.G, f.C1, f.B0]) {
    const space = outputSpace(start);
    for (let i = 0; i < space.length; i++) {
      const claim = mkClaim(start, start, BigInt(i));
      claimIndex.propagateClaim(claim);
      assertEquals(claim.resolved, true);
      assertEquals(claim.producer, space[i].block, `${start.hash.toHex().slice(0, 4)} index ${i}`);
      assertEquals(claim.outputIdx, space[i].outputIndex);
    }
  }
});

Deno.test('propagateClaim resolves refs the same way as claims', () => {
  const f = makeForest();
  const space = outputSpace(f.C);
  for (let i = 0; i < space.length; i++) {
    const resolvingRef = mkRefResolver(f.C, f.C, BigInt(i));
    claimIndex.propagateClaim(resolvingRef);
    assertEquals(resolvingRef.resolved, true);
    assertEquals(resolvingRef.producer, space[i].block, `index ${i}`);
    assertEquals(resolvingRef.outputIdx, space[i].outputIndex);
  }
});

Deno.test('propagateClaim leaves a self-claim on the claiming block', () => {
  const f = makeForest();
  const claim = mkClaim(f.C, f.C, 1n);
  claimIndex.propagateClaim(claim);
  assertEquals(claim.resolved, true);
  assertEquals(claim.producer, f.C);
  assertEquals(claim.outputIdx, 1n);
});

Deno.test('propagateClaim walks aggregates in reverse order', () => {
  const f = makeForest();
  // wp 4.5 generate_tree_space: own outputs, then `reversed(block.aggregates)`.
  // C.aggregates is [C0, C1], so the index straight after C's own outputs must
  // land in C1, and C0 comes last.
  const first = mkClaim(f.C, f.C, 2n);
  claimIndex.propagateClaim(first);
  assertEquals(first.producer, f.C1);
  assertEquals(first.outputIdx, 0n);

  const last = mkClaim(f.C, f.C, 7n);
  claimIndex.propagateClaim(last);
  assertEquals(last.producer, f.C0);
  assertEquals(last.outputIdx, 0n);
});

Deno.test('propagateClaim keeps resolution inside the aggregate subtree', () => {
  const f = makeForest();
  // wp 4.5 invariant: the `claim < agg.outputCount` guard must keep the walk
  // inside C1's tree instead of falling through to C1's anchor (B).
  const lastOfSubtree = mkClaim(f.C, f.C, 6n);
  claimIndex.propagateClaim(lastOfSubtree);
  assertEquals(lastOfSubtree.producer, f.C10);
  assertEquals(lastOfSubtree.outputIdx, 1n);

  const afterSubtree = mkClaim(f.C, f.C, 7n);
  claimIndex.propagateClaim(afterSubtree);
  assertEquals(afterSubtree.producer, f.C0);
});

Deno.test('propagateClaim throws past the end of the output space', () => {
  const f = makeForest();
  const size = outputSpace(f.C).length;
  assertThrows(
    () => claimIndex.propagateClaim(mkClaim(f.C, f.C, BigInt(size))),
    Error,
    'Claim index out of bounds',
  );
  assertThrows(
    () => claimIndex.propagateClaim(mkClaim(f.C, f.C, 1000n)),
    Error,
    'Claim index out of bounds',
  );
});

Deno.test('propagateClaim throws on an empty genesis output space', () => {
  const genesis = mkBlock('empty-genesis', 0);
  assertThrows(
    () => claimIndex.propagateClaim(mkClaim(genesis, genesis, 0n)),
    Error,
    'Claim index out of bounds',
  );
});

Deno.test('propagateClaim stops unresolved at a ref anchor', () => {
  const unknown = mkRef('unknown-anchor');
  const block = mkBlock('leaf', 1, unknown);
  const claim = mkClaim(block, block, 3n);
  claimIndex.propagateClaim(claim);
  assertEquals(claim.resolved, false);
  assertEquals(claim.producer, unknown);
  // Rebased onto the ref so it can be replayed unchanged once the ref hydrates.
  assertEquals(claim.outputIdx, 2n);
});

Deno.test('propagateClaim stops unresolved at a ref aggregate with a subtree index', () => {
  const unknown = mkRef('unknown-aggregate');
  const parent = mkBlock('parent', 2);
  aggregateRef(parent, unknown, 5n);
  const claim = mkClaim(parent, parent, 4n);
  claimIndex.propagateClaim(claim);
  assertEquals(claim.resolved, false);
  assertEquals(claim.producer, unknown);
  assertEquals(claim.outputIdx, 2n);
});

Deno.test('propagateClaim past a ref aggregate continues to the anchor', () => {
  const unknown = mkRef('skipped-aggregate');
  const anchor = mkBlock('anchor-block', 4);
  const parent = mkBlock('parent-block', 2, anchor);
  aggregateRef(parent, unknown, 5n);
  const claim = mkClaim(parent, parent, 8n);
  claimIndex.propagateClaim(claim);
  assertEquals(claim.resolved, true);
  assertEquals(claim.producer, anchor);
  assertEquals(claim.outputIdx, 1n);
});

Deno.test('propagateClaim accepts a negative claim index', () => {
  const f = makeForest();
  assertThrows(() => claimIndex.propagateClaim(mkClaim(f.C, f.C, -1n)));
});

Deno.test('propagateClaim rejects an already resolved claim', () => {
  const f = makeForest();
  const claim = mkClaim(f.C, f.C, 0n);
  claimIndex.propagateClaim(claim);
  assertThrows(() => claimIndex.propagateClaim(claim));
});

// -- resolveClaimIndex -------------------------------------------------------

Deno.test('resolveClaimIndex inverts propagateClaim over the whole output space', () => {
  const f = makeForest();
  for (const claimer of [f.C, f.B, f.A, f.G, f.C1, f.B0]) {
    const chain = anchorChainOf(claimer);
    const space = outputSpace(claimer);
    for (let i = 0; i < space.length; i++) {
      assertEquals(
        claimIndex.resolveClaimIndex(chain, space[i].block, space[i].outputIndex),
        BigInt(i),
        `${claimer.hash.toHex().slice(0, 4)} -> ${describe(space[i])}`,
      );
    }
  }
});

Deno.test('resolveClaimIndex of a self-claim is the output index itself', () => {
  const f = makeForest();
  const chain = anchorChainOf(f.C);
  assertEquals(claimIndex.resolveClaimIndex(chain, f.C, 0n), 0n);
  assertEquals(claimIndex.resolveClaimIndex(chain, f.C, 1n), 1n);
});

Deno.test('resolveClaimIndex reaches into the claiming block own tree', () => {
  const f = makeForest();
  const chain = anchorChainOf(f.C);
  assertEquals(claimIndex.resolveClaimIndex(chain, f.C1, 0n), 2n);
  assertEquals(claimIndex.resolveClaimIndex(chain, f.C10, 0n), 5n);
  assertEquals(claimIndex.resolveClaimIndex(chain, f.C0, 0n), 7n);
});

Deno.test('resolveClaimIndex skips whole anchor chain trees', () => {
  const f = makeForest();
  const chain = anchorChainOf(f.C);
  assertEquals(claimIndex.resolveClaimIndex(chain, f.B, 0n), 8n);
  assertEquals(claimIndex.resolveClaimIndex(chain, f.A, 0n), 14n);
  assertEquals(claimIndex.resolveClaimIndex(chain, f.G, 0n), 18n);
});

Deno.test('resolveClaimIndex throws for a block outside reach', () => {
  const f = makeForest();
  const chain = anchorChainOf(f.C);
  const stranger = mkBlock('stranger', 1);
  assertThrows(
    () => claimIndex.resolveClaimIndex(chain, stranger, 0n),
    Error,
    'No route found',
  );
});

Deno.test('resolveClaimIndex throws for a sibling tree that nothing has merged', () => {
  const f = makeForest();
  const sibling = mkBlock('sibling', 1, f.B);
  mkBlock('sibling-root', 1, f.B, sibling);
  // wp 4.2: siblingRoot is a tree root that no block on C's anchor chain sees.
  assertThrows(
    () => claimIndex.resolveClaimIndex(anchorChainOf(f.C), sibling, 0n),
    Error,
    'No route found',
  );
});

Deno.test('resolveClaimIndex sees a block once its tree root joins the anchor chain', () => {
  const f = makeForest();
  const late = mkBlock('late', 2, f.B);
  const lateRoot = mkBlock('late-root', 1, f.B, late);
  const claimer = mkBlock('late-claimer', 1, lateRoot);

  const chain = anchorChainOf(claimer);
  const space = outputSpace(claimer);
  for (let i = 0; i < space.length; i++) {
    assertEquals(
      claimIndex.resolveClaimIndex(chain, space[i].block, space[i].outputIndex),
      BigInt(i),
      describe(space[i]),
    );
  }
});

Deno.test('resolveClaimIndex takes the nearest aggregator once the root is re-aggregated', () => {
  const f = makeForest();
  // B is C's anchor; a later block aggregating B must not move the index of an
  // output already addressable through B's tree.
  const before = claimIndex.resolveClaimIndex(anchorChainOf(f.C), f.B00, 0n);
  mkBlock('later-aggregator', 1, undefined, f.B);
  assertEquals(claimIndex.resolveClaimIndex(anchorChainOf(f.C), f.B00, 0n), before);
});

Deno.test('resolveClaimIndex cannot address the claiming block own aggregates', () => {
  const f = makeForest();
  const anchorChain: AnchorChainNode[] = [{
    payload: { outputs: [0, 1] },
    aggregates: [{ block: f.C, outputCount: claimIndex.countOutputs(f.C) }],
  }, ...anchorChainOf(f.B)];
  assertEquals(claimIndex.resolveClaimIndex(anchorChain, f.C, 0n), 2n);
});

// -- Randomised round trip ---------------------------------------------------

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomTree(rng: () => number, name: string, depth: number, anchor?: Block): Block {
  const outputCount = Math.floor(rng() * 4);
  if (depth === 0) return mkBlock(name, outputCount, anchor);
  const arity = Math.floor(rng() * 3);
  const children: Block[] = [];
  for (let i = 0; i < arity; i++) {
    children.push(randomTree(rng, `${name}.${i}`, depth - 1));
  }
  return mkBlock(name, outputCount, anchor, ...children);
}

function randomGraph(rng: () => number): Block {
  const chainLength = 2 + Math.floor(rng() * 4);
  let previous: Block | undefined;
  for (let i = 0; i < chainLength; i++) {
    previous = randomTree(rng, `r${i}`, Math.floor(rng() * 3), previous);
  }
  return previous!;
}

Deno.test('random graphs round trip propagateClaim against resolveClaimIndex', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = makeRng(seed);
    const tip = randomGraph(rng);
    const chain = anchorChainOf(tip);
    const space = outputSpace(tip);

    for (let i = 0; i < space.length; i++) {
      const claim = mkClaim(tip, tip, BigInt(i));
      claimIndex.propagateClaim(claim);
      assertEquals(claim.resolved, true, `seed ${seed} index ${i}`);
      assertEquals(claim.producer, space[i].block, `seed ${seed} index ${i}`);
      assertEquals(claim.outputIdx, space[i].outputIndex, `seed ${seed} index ${i}`);

      assertEquals(
        claimIndex.resolveClaimIndex(chain, space[i].block, space[i].outputIndex),
        BigInt(i),
        `seed ${seed} index ${i}`,
      );
    }

    assertThrows(
      () => claimIndex.propagateClaim(mkClaim(tip, tip, BigInt(space.length))),
      Error,
      'Claim index out of bounds',
    );
  }
});
