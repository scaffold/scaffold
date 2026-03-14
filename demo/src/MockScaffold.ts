/**
 * Mock Scaffold that implements the explorer's type interface.
 * Creates a realistic block graph for demonstrating the explorer UI
 * without depending on the real Deno-based Scaffold.
 */

import type { Scaffold, Block, BlockRecordSet, Hash, Output, WorkDistribution, TrustState } from '@scaffold/explorer';

// -- Simple Hash implementation --

class SimpleHash {
  constructor(private hex: string) {}

  toHex(): string { return this.hex; }
  toPrimitive(): string { return this.hex; }

  static random(): SimpleHash {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return new SimpleHash(Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  }

  static digest(input: string): SimpleHash {
    // Simple deterministic hash for demo
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return new SimpleHash(Math.abs(hash).toString(16).padStart(64, '0'));
  }

  static zero(): SimpleHash {
    return new SimpleHash('0'.repeat(64));
  }
}

// -- Mock BlockRecordSet --

type AddCb = (block: Block) => void;
type UpdateCb = (block: Block) => void;

class MockBlockRecordSet implements BlockRecordSet {
  private blocks = new Map<string, Block>();
  private addListeners: AddCb[] = [];
  private updateListeners = new Map<Block, UpdateCb[]>();

  getAll(): Iterable<Block> { return this.blocks.values(); }
  get(hash: Hash): Block | undefined { return this.blocks.get(hash.toPrimitive()); }

  onAdd(cb: AddCb): void { this.addListeners.push(cb); }
  offAdd(cb: AddCb): void {
    const i = this.addListeners.indexOf(cb);
    if (i !== -1) this.addListeners.splice(i, 1);
  }

  onUpdate(record: Block, cb: UpdateCb): void {
    let arr = this.updateListeners.get(record);
    if (!arr) { arr = []; this.updateListeners.set(record, arr); }
    arr.push(cb);
  }

  offUpdate(record: Block, cb: UpdateCb): void {
    const arr = this.updateListeners.get(record);
    if (!arr) return;
    const i = arr.indexOf(cb);
    if (i !== -1) arr.splice(i, 1);
  }

  add(block: Block): void {
    if (this.blocks.has(block.hash.toPrimitive())) return;
    this.blocks.set(block.hash.toPrimitive(), block);
    for (const cb of this.addListeners) cb(block);
  }

  notifyChanged(block: Block): void {
    const arr = this.updateListeners.get(block);
    if (arr) for (const cb of arr) cb(block);
  }
}

// -- Mock services --

class MockConsensus {
  private canonical = new Set<string>();
  private weights = new Map<string, number>();
  private conflicts = new Map<string, Set<string>>();

  setCanonical(hash: Hash, canonical: boolean): void {
    if (canonical) this.canonical.add(hash.toPrimitive());
    else this.canonical.delete(hash.toPrimitive());
  }

  setWeight(hash: Hash, weight: number): void {
    this.weights.set(hash.toPrimitive(), weight);
  }

  addConflict(a: Hash, b: Hash): void {
    const ak = a.toPrimitive(), bk = b.toPrimitive();
    if (!this.conflicts.has(ak)) this.conflicts.set(ak, new Set());
    if (!this.conflicts.has(bk)) this.conflicts.set(bk, new Set());
    this.conflicts.get(ak)!.add(bk);
    this.conflicts.get(bk)!.add(ak);
  }

  isCanonical(hash: Hash): boolean { return this.canonical.has(hash.toPrimitive()); }
  getDescendantWeight(hash: Hash): number { return this.weights.get(hash.toPrimitive()) ?? 0; }
  getConflicts(hash: Hash): ReadonlySet<string> { return this.conflicts.get(hash.toPrimitive()) ?? new Set(); }
}

class MockSampling {
  private distributions = new Map<string, WorkDistribution>();

  setDistribution(hash: Hash, dist: WorkDistribution): void {
    this.distributions.set(hash.toPrimitive(), dist);
  }

  getDistribution(hash: Hash): WorkDistribution | undefined {
    return this.distributions.get(hash.toPrimitive());
  }
}

class MockTrust {
  private states = new Map<string, TrustState>();

  setTrustState(hash: Hash, state: TrustState): void {
    this.states.set(hash.toPrimitive(), state);
  }

  getTrustState(hash: Hash): TrustState {
    return this.states.get(hash.toPrimitive()) ?? { forAmount: 0, againstAmount: 0, activePlacements: 0 };
  }
}

// -- Factory --

function makeOutput(name: string, value: number): Output {
  return {
    verifier: { contract: SimpleHash.digest(name) as Hash, params: new Uint8Array(0) },
    value,
    detail: new TextEncoder().encode(`data-${name}`),
  };
}

function makeBlock(
  name: string,
  anchor: Hash,
  opts: {
    outputs?: Output[];
    claims?: number[];
    aggregates?: Hash[];
    refs?: Hash[];
    declaredWeight?: number;
    source?: string;
  } = {},
): Block {
  return {
    hash: SimpleHash.random() as Hash,
    anchor,
    aggregates: opts.aggregates ?? [],
    claims: opts.claims ?? [],
    outputs: opts.outputs ?? [makeOutput(name, Math.floor(Math.random() * 100))],
    declaredWeight: opts.declaredWeight ?? Math.floor(Math.random() * 20) + 1,
    refs: opts.refs ?? [],
    timestamp: Date.now() - Math.floor(Math.random() * 60000),
    receivedAt: Date.now() - Math.floor(Math.random() * 30000),
    source: opts.source ?? 'local',
  };
}

export function createMockScaffold(): Scaffold & { addBlock(): void } {
  const recordSet = new MockBlockRecordSet();
  const consensus = new MockConsensus();
  const sampling = new MockSampling();
  const trust = new MockTrust();

  const store = new Map<string, Block>();

  // Create genesis
  const genesis = makeBlock('genesis', SimpleHash.zero() as Hash, {
    outputs: [makeOutput('genesis-utxo', 1000)],
    declaredWeight: Number.MAX_SAFE_INTEGER,
    source: 'local',
  });
  store.set(genesis.hash.toPrimitive(), genesis);
  recordSet.add(genesis);
  consensus.setCanonical(genesis.hash, true);
  consensus.setWeight(genesis.hash, 1000);

  // Create initial chain
  let tip = genesis;
  const blocks: Block[] = [genesis];

  for (let i = 0; i < 5; i++) {
    const block = makeBlock(`block-${i}`, tip.hash, {
      outputs: [makeOutput(`out-${i}`, 50 + i * 10)],
      claims: [i === 0 ? 0 : 0],
      declaredWeight: 10 + i,
      source: i % 2 === 0 ? 'local' : 'remote',
    });
    store.set(block.hash.toPrimitive(), block);
    recordSet.add(block);
    consensus.setCanonical(block.hash, true);
    consensus.setWeight(block.hash, 100 - i * 15);
    sampling.setDistribution(block.hash, {
      successes: Math.floor(Math.random() * 10),
      failures: Math.floor(Math.random() * 3),
      mean: 0.7 + Math.random() * 0.3,
    });
    if (i % 3 === 0) {
      trust.setTrustState(block.hash, {
        forAmount: Math.floor(Math.random() * 100),
        againstAmount: Math.floor(Math.random() * 20),
        activePlacements: Math.floor(Math.random() * 5) + 1,
      });
    }
    blocks.push(block);
    tip = block;
  }

  // Add a conflicting block
  const conflictBlock = makeBlock('conflict', blocks[2].hash, {
    outputs: [makeOutput('conflict-out', 75)],
    declaredWeight: 8,
    source: 'remote',
  });
  store.set(conflictBlock.hash.toPrimitive(), conflictBlock);
  recordSet.add(conflictBlock);
  consensus.setCanonical(conflictBlock.hash, false);
  consensus.addConflict(blocks[3].hash, conflictBlock.hash);

  let blockCounter = blocks.length;

  const scaffold: Scaffold & { addBlock(): void } = {
    blocks: recordSet,
    context: {
      store: { get: (hash: Hash) => store.get(hash.toPrimitive()) },
      consensus,
      sampling,
      trust,
    },
    addBlock() {
      const parent = blocks[Math.floor(Math.random() * blocks.length)];
      const block = makeBlock(`dynamic-${blockCounter++}`, parent.hash, {
        outputs: [makeOutput(`dyn-out-${blockCounter}`, Math.floor(Math.random() * 200))],
        declaredWeight: Math.floor(Math.random() * 15) + 1,
        source: Math.random() > 0.5 ? 'remote' : 'local',
      });
      store.set(block.hash.toPrimitive(), block);
      recordSet.add(block);
      consensus.setCanonical(block.hash, Math.random() > 0.2);
      consensus.setWeight(block.hash, Math.floor(Math.random() * 50));
      sampling.setDistribution(block.hash, {
        successes: Math.floor(Math.random() * 8),
        failures: Math.floor(Math.random() * 2),
        mean: 0.5 + Math.random() * 0.5,
      });
      blocks.push(block);
    },
  };

  return scaffold;
}
