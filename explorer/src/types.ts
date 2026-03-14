/**
 * Minimal type interfaces for scaffold. These mirror the real types
 * so the explorer can work without importing Deno source files.
 * At runtime, the real Scaffold instance is passed in.
 */

export interface Hash {
  toHex(): string;
  toPrimitive(): string;
}

export interface Output {
  verifier: { contract: Hash; params: Uint8Array };
  value: number;
  detail: Uint8Array;
}

export interface Block {
  readonly hash: Hash;
  readonly anchor: Hash;
  readonly aggregates: Hash[];
  readonly claims: number[];
  readonly outputs: Output[];
  readonly declaredWeight: number;
  readonly refs: Hash[];
  readonly timestamp: number;
  readonly receivedAt: number;
  readonly source: string;
}

export interface WorkDistribution {
  readonly successes: number;
  readonly failures: number;
  readonly mean: number;
}

export interface TrustState {
  readonly forAmount: number;
  readonly againstAmount: number;
  readonly activePlacements: number;
}

export interface BlockRecordSet {
  getAll(): Iterable<Block>;
  get(hash: Hash): Block | undefined;
  onAdd(cb: (record: Block) => void): void;
  offAdd(cb: (record: Block) => void): void;
  onUpdate(record: Block, cb: (record: Block) => void): void;
  offUpdate(record: Block, cb: (record: Block) => void): void;
}

export interface ConsensusService {
  isCanonical(hash: Hash): boolean;
  getDescendantWeight(hash: Hash): number;
  getConflicts(hash: Hash): ReadonlySet<string>;
}

export interface SamplingService {
  getDistribution(hash: Hash): WorkDistribution | undefined;
}

export interface TrustService {
  getTrustState(hash: Hash): TrustState;
}

export interface NodeContext {
  readonly store: { get(hash: Hash): Block | undefined };
  readonly consensus: ConsensusService;
  readonly sampling: SamplingService;
  readonly trust: TrustService;
}

export interface Scaffold {
  readonly blocks: BlockRecordSet;
  readonly context: NodeContext;
}
