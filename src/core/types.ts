import { Hash } from '../util/Hash.ts';

export enum AtomType {
  Block = 0,
  Signal = 1,
  Request = 2,
}
export const BLOCK_REF_TYPE = 256;
export const DRAFT_TYPE = 257;

/** Well-known aggregation contract, takes no params so anyone may claim (wp 7). */
export const AGGREGATION_CONTRACT = Hash.digest('aggregation-contract');

export enum AtomSource {
  Genesis = 'genesis',
  Local = 'local',
  Remote = 'remote',
  Storage = 'storage',
}

export interface AtomBase {
  hash: Hash;
  type: AtomType;

  source: AtomSource;
  receivedAt: number;

  raw: Uint8Array;
  message: Uint8Array;
  signature?: Uint8Array;
  signer?: Uint8Array;

  fromConnections: string[];
  toConnections: Set<string>;
}

/**
 * The proposition a claim must satisfy: a contract partially applied to its
 * params. Mode-neutral -- generating a block finds a witness for it, verifying
 * one checks the witness.
 *
 * Params are canonical bytes here. `Query` (interfaces/Query.ts) is the
 * unresolved form, whose params may still be a lazy structured builder; a
 * Predicate is assignable to a Query, never the reverse.
 */
export interface Predicate {
  contract: Hash;
  params: Uint8Array;
}

/** A resource produced by a block, governed by the predicate it extends. */
export interface Output extends Predicate {
  data?: Uint8Array;
  amount: bigint;
}

export interface BlockPayload {
  anchor: Hash;
  chain: { weight: bigint; throughput: bigint }[];
  aggregates: { block: Hash; outputCount: bigint }[];
  claims: bigint[];
  refs: bigint[];
  outputs: Output[];
  timestampMs: number;
}

type Check = (val: unknown) => boolean;

const isBigint: Check = (val) => typeof val === 'bigint';
const isHash: Check = (val) => val instanceof Hash;
const isBytes: Check = (val) => val instanceof Uint8Array;
const isOptionalBytes: Check = (val) => val === undefined || isBytes(val);
const arrayOf = (check: Check): Check => (val) => Array.isArray(val) && val.every(check);

/** Structural match, rejecting unknown keys so junk can't ride along inside a signed block. */
const shape = (fields: Record<string, Check>): Check => (val) =>
  typeof val === 'object' && val !== null && !Array.isArray(val) &&
  Object.keys(val).every((key) => key in fields) &&
  Object.entries(fields).every(([key, check]) => check((val as Record<string, unknown>)[key]));

// Structural only: the sign and range rules of wp 5.1 are validity, not shape.
// `timestampMs` is bounded to finite because NaN/Infinity stringify to null and
// so cannot survive the wire at all.
const blockPayloadShape = shape({
  anchor: isHash,
  chain: arrayOf(shape({ weight: isBigint, throughput: isBigint })),
  aggregates: arrayOf(shape({ block: isHash, outputCount: isBigint })),
  claims: arrayOf(isBigint),
  refs: arrayOf(isBigint),
  outputs: arrayOf(
    shape({ contract: isHash, params: isBytes, data: isOptionalBytes, amount: isBigint }),
  ),
  timestampMs: (val) => typeof val === 'number' && Number.isFinite(val),
});

export function isBlockPayload(p: unknown): p is BlockPayload {
  return blockPayloadShape(p);
}

export enum OutputResolverType {
  Claim,
  Ref,
}

export interface ResolvingClaim {
  type: OutputResolverType.Claim;
  producer: Block | BlockRef;
  outputIdx: bigint;
  claimer: Node;
  claimIdx: number;
  resolved: boolean;
}

export interface ResolvingRef {
  type: OutputResolverType.Ref;
  producer: Block | BlockRef;
  outputIdx: bigint;
  reffer: Node;
  refIdx: number;
  resolved: boolean;
}

export enum BlockActionType {
  LinkAnchor,
  LinkAnchoringNode,
  LinkAggregate,
  LinkAggregatingNode,
  LinkClaim,
  LinkClaimingNode,
  CanonicalityChange,
}

export type BlockAction =
  | { type: BlockActionType.LinkAnchor; anchor: Block }
  | { type: BlockActionType.LinkAnchoringNode; anchoringNode: Block }
  | { type: BlockActionType.LinkAggregate; aggregate: Block; index: number }
  | { type: BlockActionType.LinkAggregatingNode; aggregatingNode: Block; index: number }
  | { type: BlockActionType.LinkClaim; claim: ResolvingClaim }
  | { type: BlockActionType.LinkClaimingNode; claim: ResolvingClaim }
  | { type: BlockActionType.CanonicalityChange; isCanonical: boolean };

export interface Block extends AtomBase {
  type: AtomType.Block;

  payload: BlockPayload;

  anchor?: Block | BlockRef;
  aggregates: { block: Block | BlockRef; outputCount: bigint }[];
  claims: ResolvingClaim[];
  refs: ResolvingRef[];

  // These are other nodes referring to this atom by hash
  anchoringNodes: Block[];
  aggregatingNodes: Block[];
  resolvingOutputs: Map<bigint, (ResolvingClaim | ResolvingRef)[]>;

  // Listeners fire when any adjacent node is attached or modified.
  // An adjacent node is an anchor, anchoring node, aggregated node, or aggregating node.
  listeners: Set<(action: BlockAction) => void>;
}

export interface Signal extends AtomBase {
  type: AtomType.Signal;

  payload: {};
}

export type Atom = Block | Signal;

// When a block is only known by hash, it's a BlockRef
export interface BlockRef {
  hash: Hash;
  type: typeof BLOCK_REF_TYPE;

  ingestionError?: string;

  // List of connections that know the block behind this ref
  connections: string[];

  // These are other nodes referring to this block by hash
  anchoringNodes: Block[];
  aggregatingNodes: Block[];
  resolvingOutputs: Map<bigint, (ResolvingClaim | ResolvingRef)[]>;

  // Listeners fire when any adjacent node is attached or modified.
  // An adjacent node is an anchor, anchoring node, aggregated node, or aggregating node.
  listeners: Set<(action: BlockAction) => void>;
}

export enum DraftStatusType {
  Populating, // The producer is filling the draft in place. The only phase in which `update` is legal.
  Ready, // The producer has handed off. Eligible for merging into a building batch; but it will NOT be built on its own.
  Building, // No generated blocks are canonical. Building is in progress. The manager will retry on canonicality changes until it succeeds.
  Built, // Building has completed, and the generated block is canonical.
  Cancelled, // This draft has been cancelled.
}

export type DraftStatus =
  | { type: DraftStatusType.Populating }
  | { type: DraftStatusType.Ready }
  | { type: DraftStatusType.Building; stalledReason: {}; hooks: AbortController }
  | { type: DraftStatusType.Built; block: Block }
  | { type: DraftStatusType.Cancelled; cancelledReason: string };

export const DRAFT_SELF: unique symbol = Symbol('Draft.Self');

export interface DraftPayload {
  claims: { producer: Block | typeof DRAFT_SELF; outputIndex: bigint }[];
  refs: { producer: Block | typeof DRAFT_SELF; outputIndex: bigint }[];
  outputs: Output[];

  // Note: Generally, drafts shouldn't refer (anchor or claim) other drafts
}

export interface Draft extends DraftPayload {
  type: typeof DRAFT_TYPE;

  status: DraftStatus;
  ioDelta: bigint;
  builtBlocks: Block[];

  // Listeners fire when a block is built and becomes canonical, or a previously canonical block becomes uncanonical.
  // There will never be more than one canonical block generated from a draft.
  listeners: Set<(block?: Block) => void>;
}

export type Node = Block | Draft;
