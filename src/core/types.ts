import { Hash } from '../util/Hash.ts';

export enum AtomType {
  Block = 0,
  Signal = 1,
  Request = 2,
}
export const DRAFT_TYPE = 256;

export enum AtomSource {
  Local = 'local',
  Remote = 'remote',
  Storage = 'storage',
}

export interface AtomBase {
  readonly hash: Hash;
  readonly type: AtomType;

  readonly source: AtomSource;
  readonly receivedAt: number;

  readonly raw: Uint8Array;
  readonly message: Uint8Array;
  readonly signature?: Uint8Array;
  readonly signer?: Uint8Array;

  readonly fromConnections: string[];
  readonly toConnections: Set<string>;
}

export interface BlockPayload {
  anchor: Hash;
  chain: { weight: bigint; throughput: bigint }[];
  aggregates: { block: Hash; outputCount: bigint }[];
  claims: bigint[];
  refs: bigint[];
  outputs: { contractHash: Hash; params: Uint8Array; data?: Uint8Array; amount: bigint }[];
  timestampMs: number;
}

export function isBlockPayload(p: unknown): p is BlockPayload {
  // TODO(claude): Implement this
}

export interface Block extends AtomBase {
  readonly type: AtomType.Block;

  readonly payload: BlockPayload;

  readonly anchor?: Block;
  readonly claims: { producer: Hash; outputIndex: bigint }[];
}

export interface Signal extends AtomBase {
  readonly type: AtomType.Signal;

  readonly payload: {};
}

export type Atom = Block | Signal;

export interface Draft {
  readonly type: typeof DRAFT_TYPE;

  readonly claims: { producer: Hash; outputIndex: bigint }[];

  // Note: Generally, drafts shouldn't refer (anchor or claim) other drafts
}

export type Node = Block | Draft;
