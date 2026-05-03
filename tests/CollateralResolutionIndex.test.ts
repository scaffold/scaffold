import { PacketType } from '../src/core/Packet.ts';
import { assertEquals } from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import { AtomSource, AtomType, type Block } from '../src/core/Block.ts';
import type { Draft } from '../src/core/Draft.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import { encodeVerdict, VERDICT_RECORD_KEY } from '../src/contracts/CollateralContract.ts';
import { blockNodeFields, withNodeFields } from './testutil/blockNodeFields.ts';
import {
  CollateralResolutionIndex,
  type CollateralResolutionIndexProvider,
  type VerdictQuery,
  type VerificationStatus,
} from '../src/node/CollateralResolutionIndex.ts';

// -- Test provider ----------------------------------------------------

class MockProvider implements CollateralResolutionIndexProvider {
  readonly blocks = new Map<HashPrimitive, Block>();
  readonly readyDrafts = new Map<HashPrimitive, Draft>();
  readonly verifyStatus = new Map<HashPrimitive, VerificationStatus>();
  readonly canonical = new Set<HashPrimitive>();

  private readonly blockAddCbs: ((block: Block) => void)[] = [];
  private readonly draftCbs: ((draft: Draft) => void)[] = [];
  private readonly verifyCbs: ((h: Hash, s: VerificationStatus) => void)[] = [];
  private readonly canonCbs: ((h: Hash, c: boolean) => void)[] = [];

  iterateBlocks(): Iterable<Block> {
    return this.blocks.values();
  }
  iterateReadyDrafts(): Iterable<Draft> {
    return this.readyDrafts.values();
  }
  onBlockAdded(cb: (block: Block) => void): () => void {
    this.blockAddCbs.push(cb);
    return () => {
      const i = this.blockAddCbs.indexOf(cb);
      if (i >= 0) this.blockAddCbs.splice(i, 1);
    };
  }
  onDraftTransition(cb: (draft: Draft) => void): () => void {
    this.draftCbs.push(cb);
    return () => {};
  }
  getVerificationStatus(h: Hash): VerificationStatus {
    return this.verifyStatus.get(h.toPrimitive()) ?? 'unknown';
  }
  onVerificationStatusChanged(
    cb: (h: Hash, s: VerificationStatus) => void,
  ): () => void {
    this.verifyCbs.push(cb);
    return () => {};
  }
  isCanonical(h: Hash): boolean {
    return this.canonical.has(h.toPrimitive());
  }
  onCanonicalityChanged(cb: (h: Hash, canonical: boolean) => void): () => void {
    this.canonCbs.push(cb);
    return () => {};
  }

  // -- test-side mutators --

  addBlock(
    block: Block,
    opts: { canonical?: boolean; status?: VerificationStatus } = {},
  ): void {
    this.blocks.set(block.hash.toPrimitive(), block);
    if (opts.canonical) this.canonical.add(block.hash.toPrimitive());
    if (opts.status) this.verifyStatus.set(block.hash.toPrimitive(), opts.status);
    for (const cb of this.blockAddCbs) cb(block);
  }

  setVerification(h: Hash, s: VerificationStatus): void {
    this.verifyStatus.set(h.toPrimitive(), s);
    for (const cb of this.verifyCbs) cb(h, s);
  }

  setCanonical(h: Hash, c: boolean): void {
    if (c) this.canonical.add(h.toPrimitive());
    else this.canonical.delete(h.toPrimitive());
    for (const cb of this.canonCbs) cb(h, c);
  }

  addDraft(draft: Draft, canonical = true): void {
    if (draft.status === 'ready') {
      this.readyDrafts.set(draft.draftId.toPrimitive(), draft);
    }
    if (canonical) this.canonical.add(draft.draftId.toPrimitive());
    for (const cb of this.draftCbs) cb(draft);
  }

  transitionDraft(draft: Draft): void {
    if (draft.status === 'cancelled') {
      this.readyDrafts.delete(draft.draftId.toPrimitive());
    } else if (draft.status === 'ready') {
      this.readyDrafts.set(draft.draftId.toPrimitive(), draft);
    }
    for (const cb of this.draftCbs) cb(draft);
  }
}

// -- Test helpers ----------------------------------------------------

const h = (s: string): Hash => Hash.digest(s);

function makeBlock(
  hash: Hash,
  target: Hash | null,
  verdict: 'valid' | 'invalid' | null,
): Block {
  const outputs = verdict && target
    ? [makeRecordOutput(VERDICT_RECORD_KEY, encodeVerdict({ target, verdict }))]
    : [];
  return withNodeFields({
    hash,
    anchor: Hash.digest('anchor'),
    aggregates: [],
    claimIndices: [],
    outputs,
    declaredWeight: 0,
    refs: [],
    timestamp: 1000,
    receivedAt: 1000,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    fromConnections: [],
    toConnections: new Set(),
    source: AtomSource.Remote,
    ...blockNodeFields(hash, [], 0),
  });
}

function makeDraft(
  draftId: Hash,
  target: Hash,
  verdict: 'valid' | 'invalid',
  status: 'ready' | 'pending' | 'cancelled' = 'ready',
): Draft {
  const verdictOutput = makeRecordOutput(
    VERDICT_RECORD_KEY,
    encodeVerdict({ target, verdict }),
  );
  return {
    kind: 'draft',
    claims: [],
    effectiveWeight: 0,
    draftId,
    outputs: [verdictOutput],
    outputSlots: [{ output: verdictOutput, origin: 'require' }],
    declaredWeight: 0,
    refs: [],
    status,
  };
}

// -- Tests ------------------------------------------------------------

Deno.test('CRI: valid verdict block, canonical + passed => valid', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  const R = h('R');
  p.addBlock(makeBlock(R, T, 'valid'), { canonical: true, status: 'passed' });
  assertEquals(idx.verdict(T), 'valid');
});

Deno.test('CRI: invalid verdict block, canonical + passed => invalid', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  p.addBlock(makeBlock(h('R'), T, 'invalid'), {
    canonical: true,
    status: 'passed',
  });
  assertEquals(idx.verdict(T), 'invalid');
});

Deno.test('CRI: block without verdict output never contributes', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  p.addBlock(makeBlock(h('R'), null, null), {
    canonical: true,
    status: 'passed',
  });
  assertEquals(idx.verdict(T), 'none');
});

Deno.test('CRI: block with verdict, verification failed, never contributes', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  p.addBlock(makeBlock(h('R'), T, 'valid'), {
    canonical: true,
    status: 'failed',
  });
  assertEquals(idx.verdict(T), 'none');
});

Deno.test('CRI: pending block promotes when verification passes', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  const R = h('R');
  p.addBlock(makeBlock(R, T, 'valid'), {
    canonical: true,
    status: 'verifying',
  });
  assertEquals(idx.verdict(T), 'none');
  p.setVerification(R, 'passed');
  assertEquals(idx.verdict(T), 'valid');
});

Deno.test('CRI: pending block dropped when verification fails', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  const R = h('R');
  p.addBlock(makeBlock(R, T, 'valid'), {
    canonical: true,
    status: 'verifying',
  });
  p.setVerification(R, 'failed');
  assertEquals(idx.verdict(T), 'none');
  // Later flip to passed should still not revive (pending was removed).
  p.setVerification(R, 'passed');
  assertEquals(idx.verdict(T), 'none');
});

Deno.test('CRI: ready + canonical draft with verdict contributes', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  const D = h('draft');
  p.addDraft(makeDraft(D, T, 'invalid', 'ready'), true);
  assertEquals(idx.verdict(T), 'invalid');
});

Deno.test('CRI: cancelled draft retracts verdict', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  const D = h('draft');
  p.addDraft(makeDraft(D, T, 'valid', 'ready'), true);
  assertEquals(idx.verdict(T), 'valid');
  p.transitionDraft(makeDraft(D, T, 'valid', 'cancelled'));
  assertEquals(idx.verdict(T), 'none');
});

Deno.test('CRI: non-canonical source withheld from query', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  const R = h('R');
  p.addBlock(makeBlock(R, T, 'valid'), { canonical: false, status: 'passed' });
  assertEquals(idx.verdict(T), 'none');
  p.setCanonical(R, true);
  assertEquals(idx.verdict(T), 'valid');
  p.setCanonical(R, false);
  assertEquals(idx.verdict(T), 'none');
});

Deno.test('CRI: invalid beats valid across multiple sources', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  p.addBlock(makeBlock(h('R1'), T, 'valid'), {
    canonical: true,
    status: 'passed',
  });
  assertEquals(idx.verdict(T), 'valid');
  p.addBlock(makeBlock(h('R2'), T, 'invalid'), {
    canonical: true,
    status: 'passed',
  });
  assertEquals(idx.verdict(T), 'invalid');
});

Deno.test('CRI: bootstrap picks up pre-existing blocks and drafts', () => {
  const p = new MockProvider();
  const T = h('target');
  const R = h('R');
  const D = h('draft');
  // Pre-populate before constructing the index.
  p.blocks.set(R.toPrimitive(), makeBlock(R, T, 'valid'));
  p.canonical.add(R.toPrimitive());
  p.verifyStatus.set(R.toPrimitive(), 'passed');
  p.readyDrafts.set(D.toPrimitive(), makeDraft(D, T, 'invalid', 'ready'));
  p.canonical.add(D.toPrimitive());

  const idx = new CollateralResolutionIndex(p);
  // Draft (invalid) beats block (valid).
  assertEquals(idx.verdict(T), 'invalid');
});

Deno.test('CRI: onVerdictChanged fires on transitions, dedupes stable state', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  const events: VerdictQuery[] = [];
  idx.onVerdictChanged((_, v) => events.push(v));

  p.addBlock(makeBlock(h('R1'), T, 'valid'), {
    canonical: true,
    status: 'passed',
  });
  // none -> valid
  assertEquals(events, ['valid']);

  // Adding a second 'valid' source shouldn't re-fire (still 'valid').
  p.addBlock(makeBlock(h('R2'), T, 'valid'), {
    canonical: true,
    status: 'passed',
  });
  assertEquals(events, ['valid']);

  // Escalating to invalid fires.
  p.addBlock(makeBlock(h('R3'), T, 'invalid'), {
    canonical: true,
    status: 'passed',
  });
  assertEquals(events, ['valid', 'invalid']);
});

Deno.test('CRI: canonicality flip on source fires verdict event', () => {
  const p = new MockProvider();
  const idx = new CollateralResolutionIndex(p);
  const T = h('target');
  const R = h('R');
  const events: VerdictQuery[] = [];
  idx.onVerdictChanged((_, v) => events.push(v));
  p.addBlock(makeBlock(R, T, 'valid'), { canonical: true, status: 'passed' });
  assertEquals(events, ['valid']);
  p.setCanonical(R, false);
  assertEquals(events, ['valid', 'none']);
  p.setCanonical(R, true);
  assertEquals(events, ['valid', 'none', 'valid']);
});
