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
    shape({ contractHash: isHash, params: isBytes, data: isOptionalBytes, amount: isBigint }),
  ),
  timestampMs: (val) => typeof val === 'number' && Number.isFinite(val),
});

export function isBlockPayload(p: unknown): p is BlockPayload {
  return blockPayloadShape(p);
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
