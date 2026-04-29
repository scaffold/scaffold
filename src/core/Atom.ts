// Atom: every hash-identified, ingested artifact in Scaffold.
//
// An Atom is the durable record of one wire packet (or local compose):
// raw bytes, hash, optional signature, and reception metadata. Domain
// subtypes (Block, Signal, Request today; Index and others in future
// passes) extend `AtomBase` and narrow the `type` discriminator.
//
// Two enums separate concerns:
//
//   PacketType (1 wire byte) selects which ingestor parses the bytes.
//   AtomType is the logical kind of the resulting object.
//
// Two `PacketType`s can produce the same `AtomType` -- e.g. a future
// `BinarySignedBlock` would join `JsonSignedBlock` in producing
// `AtomType.Block`.

import { Hash } from '../util/Hash.ts';
import { PacketType } from './Packet.ts';

// -- AtomType (logical kind) ----------------------------------------

/**
 * Logical kind of an Atom. Each value corresponds to one or more
 * `PacketType`s; the relationship is many-to-one (multiple wire
 * encodings can produce the same logical kind).
 */
export enum AtomType {
  Block = 0,
  Signal = 1,
  Request = 2,
}

// -- AtomSource (reception channel) ---------------------------------

/**
 * How an Atom arrived at this node. String values match the historic
 * `BlockSource` constants so on-disk and in-memory test fixtures
 * round-trip unchanged.
 */
export enum AtomSource {
  Local = 'local',
  Remote = 'remote',
  Storage = 'storage',
}

// -- AtomBase (shared structural fields) ----------------------------

/**
 * Structural base shared by every Atom subtype. Subtypes redeclare
 * `type` with a literal `AtomType.*` value to act as the discriminator
 * for the `Atom` union.
 *
 * Functions that only need wire/transit fields can type their
 * parameter as `AtomBase`; functions that dispatch on the kind should
 * use `Atom` so TypeScript can narrow.
 */
export interface AtomBase {
  /** SHA3-256 of `raw`. Stable identity. */
  readonly hash: Hash;

  /** Logical kind. Subtypes narrow this to a literal. */
  readonly type: AtomType;

  /** Wire-encoding tag (4th byte of `raw`). */
  readonly packetType: PacketType;

  /** Canonical wire bytes: `[SCF magic][type][payload][signature?]`. */
  readonly raw: Uint8Array;

  /** Raw 65-byte signature (compact + recovery), if signed. */
  readonly signature?: Uint8Array;

  /** 33-byte compressed secp256k1 pubkey recovered from `signature`. */
  readonly signer?: Uint8Array;

  /** How this atom arrived. */
  readonly source: AtomSource;

  /** Reception time at this node (Date.now()). */
  readonly receivedAt: number;
}

// -- Atom (discriminated union) -------------------------------------

// Type-only imports break the runtime cycle between Atom.ts and the
// subtype modules. At runtime each subtype imports AtomBase / AtomType /
// AtomSource values from this module; the union below is purely
// type-level.
import type { Block } from './Block.ts';
import type { SignalAtom } from './SignalAtom.ts';
import type { RequestAtom } from './RequestAtom.ts';

/**
 * Discriminated union of every concrete Atom subtype. As more wire
 * objects (Index, ...) migrate onto the Atom abstraction, they get
 * added here.
 */
export type Atom = Block | SignalAtom | RequestAtom;
