import { Hash } from '../util/Hash.ts';

/**
 * The proposition a claim must satisfy: a contract partially applied to its
 * params. Mode-neutral -- generating a block finds a witness for it, verifying
 * one checks the witness.
 *
 * Params are canonical bytes here. `Query` (contract/Query.ts) is the
 * unresolved form, whose params may still be a lazy structured builder; a
 * Predicate is assignable to a Query, never the reverse.
 */
export interface Predicate {
  contract: Hash;
  params: Uint8Array;
}

/** A resource produced by a block, governed by the predicate it extends. */
export interface Output extends Predicate {
  body?: Uint8Array;
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
    shape({ contract: isHash, params: isBytes, body: isOptionalBytes, amount: isBigint }),
  ),
  timestampMs: (val) => typeof val === 'number' && Number.isFinite(val),
});

export function isBlockPayload(p: unknown): p is BlockPayload {
  return blockPayloadShape(p);
}
