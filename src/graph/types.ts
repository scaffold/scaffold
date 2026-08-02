import { Hash } from '../util/Hash.ts';
import { AtomSource, AtomType, BLOCK_REF_TYPE, DRAFT_TYPE } from '../logic/tags.ts';
import { BlockPayload, Output, Predicate } from './payload.ts';

export { AtomSource, AtomType, BLOCK_REF_TYPE, DRAFT_TYPE } from '../logic/tags.ts';
export { type BlockPayload, isBlockPayload, type Output, type Predicate } from './payload.ts';

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
  claims: { producer: Block | typeof DRAFT_SELF; outputIndex: number }[];
  refs: { producer: Block | typeof DRAFT_SELF; outputIndex: number }[];
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
