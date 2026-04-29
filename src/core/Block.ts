// Protocol spec: docs/protocol/block-creation.md (block structure), docs/protocol/contracts.md (standard contracts), docs/protocol/dag.md (graph topology)

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { BlockBlueprint, Output } from './BlockCreationModule.ts';
import { AtomBase, AtomSource, AtomType } from './Atom.ts';
import { composePacket, composeUnsignedPacket, PacketType } from './Packet.ts';
import { JsonIngestor } from './PacketIngestor.ts';
import { secp } from '../util/secp.ts';

// Re-export Atom types for callers that pull `Block` and source/kind
// constants together. Keeps test fixtures compact.
export { AtomSource, AtomType } from './Atom.ts';

/** Genesis blocks use this as their declared weight (very high). */
export const GENESIS_WEIGHT = Number.MAX_SAFE_INTEGER;

/** Well-known contract hash for aggregation contract outputs. */
export const AGGREGATION_CONTRACT = Hash.digest('aggregation-contract');

/** Well-known contract hash for collateral contract outputs (FOR/AGAINST). */
export const COLLATERAL_CONTRACT = Hash.digest('collateral-contract');

/** Well-known contract hash for insurance contract outputs. */
export const INSURANCE_CONTRACT = Hash.digest('insurance-contract');

/** Well-known contract hash for signature (payment) contract outputs. */
export const SIGNATURE_CONTRACT = Hash.digest('signature-contract');

/** Well-known contract hash for record outputs (key-value store on a block). */
export const RECORD_CONTRACT = Hash.digest('result-contract');

/**
 * Well-known contract hash for the chess-demo game-state contract. Lives in
 * core so tests and services can reference a stable hash without depending on
 * the demo module.
 */
export const GAME_STATE_CONTRACT = Hash.digest('chess-game-state-contract');

import { getAggregationData } from '../contracts/AggregationContract.ts';

/**
 * Get the claim mask for a block: from aggregation data if present,
 * otherwise computed from claims for leaf blocks.
 * Returns a sorted array of anchor output indices that the block's subtree claims.
 */
export function getBlockClaimMask(block: Block, _anchorOutputCount?: number): number[] {
  const aggData = getAggregationData(block);
  if (aggData) return aggData.claimMask;
  // Leaf block: non-self claims map directly to anchor indices
  const ownOutputCount = block.outputs.length;
  const mask: number[] = [];
  for (const claimIdx of block.claims) {
    if (claimIdx >= ownOutputCount) {
      mask.push(claimIdx - ownOutputCount);
    }
  }
  mask.sort((a, b) => a - b);
  return mask;
}

/**
 * Get the weight vector for a block: reconstructed from declaredWeight + chainWeights.
 */
export function getBlockWeightVector(block: Block): number[] {
  const aggData = getAggregationData(block);
  if (aggData && aggData.chainWeights.length > 0) {
    const result = [...aggData.chainWeights];
    result[0] += block.declaredWeight;
    return result;
  }
  return [block.declaredWeight];
}

// -- Block interface ------------------------------------------------

/**
 * Concrete block type: an Atom whose payload carries the consensus
 * fields (anchor, claims, outputs, declaredWeight, refs).
 *
 * Wire identity (hash, raw, signature, signer, packetType) and
 * reception metadata (source, receivedAt) are inherited from
 * `AtomBase`. Domain-specific data (aggregation state, collateral,
 * payment) lives in contract outputs within the `outputs` array.
 */
export interface Block extends AtomBase {
  /** Discriminator for the `Atom` union. */
  readonly type: AtomType.Block;
  /** Block packets are JSON-encoded today; binary encodings will join later. */
  readonly packetType: PacketType.JsonSignedBlock | PacketType.JsonUnsignedBlock;

  readonly anchor: Hash;
  readonly aggregates: Hash[];
  readonly claims: number[];
  readonly outputs: Output[];
  readonly declaredWeight: number;
  /** Cross-block references for read-only data access. */
  readonly refs: Hash[];
  /** Resolved claims -- concrete output references for uniform claim handling. */
  readonly resolvedClaims?: import('./BlockDraft.ts').ClaimIntent[];
  /** Creation time, set by block creator (wire format). */
  readonly timestamp: number;
  /** Block's own verification cost (excluding subtrees). Used by probing. */
  readonly selfWeight?: number;
  /** Total weight of the block's subtree (self + aggregates). Used by probing. */
  readonly subtreeWeight?: number;
}

// -- BlockStore -----------------------------------------------------

/** In-memory block store with structural queries. */
export class BlockStore {
  private readonly blocks = new Map<HashPrimitive, Block>();
  private readonly aggregated = new Set<HashPrimitive>();
  private readonly _addListeners: ((block: Block) => void)[] = [];

  get(hash: Hash): Block | undefined {
    return this.blocks.get(hash.toPrimitive());
  }

  /**
   * Register a listener fired after a new block is inserted via `put()`.
   * Not fired on re-puts of an already-stored hash.
   */
  onAdded(cb: (block: Block) => void): () => void {
    this._addListeners.push(cb);
    return () => {
      const i = this._addListeners.indexOf(cb);
      if (i >= 0) this._addListeners.splice(i, 1);
    };
  }

  put(block: Block): void {
    const key = block.hash.toPrimitive();
    const isNew = !this.blocks.has(key);
    this.blocks.set(key, block);

    // Track which blocks get aggregated
    for (const agg of block.aggregates) {
      this.aggregated.add(agg.toPrimitive());
    }

    if (isNew) {
      for (const cb of this._addListeners) cb(block);
    }
  }

  has(hash: Hash): boolean {
    return this.blocks.has(hash.toPrimitive());
  }

  /** Whether a block has been aggregated by another block. */
  isAggregated(hash: Hash): boolean {
    return this.aggregated.has(hash.toPrimitive());
  }

  /** Iterate over all stored blocks. */
  values(): IterableIterator<Block> {
    return this.blocks.values();
  }

  /** Walk anchor chain to determine if `ancestor` is an ancestor of `descendant`. */
  isAncestor(ancestor: Hash, descendant: Hash): boolean {
    const ancestorKey = ancestor.toPrimitive();
    let current: Hash = descendant;

    while (!Hash.equals(current, ZERO_HASH)) {
      if (current.toPrimitive() === ancestorKey) return true;
      const block = this.blocks.get(current.toPrimitive());
      if (!block) return false;
      current = block.anchor;
    }

    return false;
  }

  /**
   * Get the depth of `ancestor` in the anchor chain starting from `from`.
   * Depth 0 means `from` === `ancestor`'s hash.
   * Returns undefined if `ancestor` is not in `from`'s anchor chain.
   */
  getAnchorDepth(from: Hash, ancestor: Hash): number | undefined {
    const ancestorKey = ancestor.toPrimitive();
    let current: Hash = from;
    let depth = 0;

    while (!Hash.equals(current, ZERO_HASH)) {
      if (current.toPrimitive() === ancestorKey) return depth;
      const block = this.blocks.get(current.toPrimitive());
      if (!block) return undefined;
      current = block.anchor;
      depth++;
    }

    return undefined;
  }
}

/**
 * Get the outputs of a referenced block at the given ref index.
 * Returns undefined if the ref index is out of bounds or the referenced
 * block is not in the store.
 */
export function getRefOutputs(
  block: Block,
  refIndex: number,
  store: BlockStore,
): Output[] | undefined {
  if (refIndex < 0 || refIndex >= block.refs.length) return undefined;
  const refHash = block.refs[refIndex];
  const refBlock = store.get(refHash);
  if (!refBlock) return undefined;
  return refBlock.outputs;
}

// -- Output space ---------------------------------------------------

/**
 * Collect a block's output space: the final, post-claim set of surviving
 * outputs. This is the clean set that descendants inherit.
 *
 * Output space = [own outputs, surviving anchor outputs after claims]
 */
export function collectExtendedOutputs(block: Block, store: BlockStore): Output[] {
  const result: Output[] = [...block.outputs];

  if (Hash.equals(block.anchor, ZERO_HASH)) {
    // Genesis -- only own outputs
    return result;
  }

  const anchorBlock = store.get(block.anchor);
  if (!anchorBlock) return result;

  const anchorOutputs = collectExtendedOutputs(anchorBlock, store);
  const claimMask = getBlockClaimMask(block, anchorOutputs.length);

  // Add surviving anchor outputs (those not claimed by this block)
  const claimSet = new Set(claimMask);
  for (let i = 0; i < anchorOutputs.length; i++) {
    if (!claimSet.has(i)) {
      result.push(anchorOutputs[i]);
    }
  }

  return result;
}

// -- BlockPayload ---------------------------------------------------

/**
 * Block fields carried in the wire payload -- everything except hash,
 * the AtomBase identity/transit fields, and the new packet metadata.
 * `signer` is node-local (recovered from the signature, not serialized).
 */
export type BlockPayload = Omit<
  Block,
  | 'hash'
  | 'receivedAt'
  | 'source'
  | 'signer'
  | 'type'
  | 'packetType'
  | 'raw'
  | 'signature'
>;

/** Construct a Block from a deserialized packet payload and the wire metadata. */
export function createBlockFromPacket(
  payload: BlockPayload,
  raw: Uint8Array,
  hash: Hash,
  packetType: PacketType.JsonSignedBlock | PacketType.JsonUnsignedBlock,
  source: AtomSource = AtomSource.Remote,
  signature?: Uint8Array,
  signer?: Uint8Array,
): Block {
  const now = Date.now();
  return {
    hash,
    type: AtomType.Block,
    packetType,
    raw,
    signature,
    signer,
    source,
    receivedAt: now,
    anchor: payload.anchor,
    aggregates: payload.aggregates,
    claims: payload.claims,
    outputs: payload.outputs,
    declaredWeight: payload.declaredWeight,
    refs: payload.refs,
    timestamp: payload.timestamp ?? now,
  };
}

// -- Compose helpers -------------------------------------------------
//
// These produce signed/unsigned/genesis Blocks from blueprints. They
// live in Block.ts (not Packet.ts) because they construct a Block --
// keeping them here lets `createBlock` / `createGenesisBlock` reuse
// them without a Block.ts <-> Packet.ts import cycle.

function blueprintToPayload(blueprint: BlockBlueprint): BlockPayload {
  return {
    anchor: blueprint.anchor,
    aggregates: blueprint.aggregates,
    claims: blueprint.claims,
    outputs: blueprint.outputs,
    declaredWeight: blueprint.declaredWeight,
    refs: blueprint.refs,
    timestamp: Date.now(),
  };
}

/** Compose a signed block packet and return the resulting Block. */
export function composeBlockPacket(blueprint: BlockBlueprint, privateKey: Uint8Array): Block {
  const payload = blueprintToPayload(blueprint);
  const packet = composePacket<BlockPayload>(PacketType.JsonSignedBlock, payload, privateKey);
  const signer = secp.getPublicKey(privateKey, true);
  return createBlockFromPacket(
    payload,
    packet.raw,
    packet.hash,
    PacketType.JsonSignedBlock,
    AtomSource.Local,
    packet.signature,
    signer,
  );
}

/** Compose an unsigned block packet and return the resulting Block. */
export function composeUnsignedBlockPacket(blueprint: BlockBlueprint): Block {
  const payload = blueprintToPayload(blueprint);
  const packet = composeUnsignedPacket<BlockPayload>(PacketType.JsonUnsignedBlock, payload);
  return createBlockFromPacket(
    payload,
    packet.raw,
    packet.hash,
    PacketType.JsonUnsignedBlock,
    AtomSource.Local,
  );
}

/** Compose a genesis block (unsigned, fixed-shape payload). */
export function composeGenesisPacket(outputs: Output[]): Block {
  const payload: BlockPayload = {
    anchor: ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs,
    declaredWeight: GENESIS_WEIGHT,
    refs: [],
    timestamp: 0,
  };
  const packet = composeUnsignedPacket<BlockPayload>(PacketType.JsonUnsignedBlock, payload);
  return createBlockFromPacket(
    payload,
    packet.raw,
    packet.hash,
    PacketType.JsonUnsignedBlock,
    AtomSource.Local,
  );
}

// -- Factory functions ----------------------------------------------

/**
 * Test-friendly helper that composes an unsigned block packet from a
 * blueprint. Identical to `composeUnsignedBlockPacket` but takes the
 * resolved anchor block as a parameter for legacy call-site signature
 * compatibility (the parameter is unused -- the blueprint already
 * carries the anchor hash).
 */
export function createBlock(blueprint: BlockBlueprint, _anchorBlock: Block): Block {
  return composeUnsignedBlockPacket(blueprint);
}

/**
 * Create a genesis block with the given outputs. Hash and raw bytes
 * derive from the wire encoding so all Blocks satisfy
 * `Hash.digest(block.raw) === block.hash`.
 */
export function createGenesisBlock(outputs: Output[]): Block {
  return composeGenesisPacket(outputs);
}

// -- Block ingestors -------------------------------------------------
//
// One JsonIngestor per block PacketType. Both produce `AtomType.Block`;
// the signed instance recovers the signer from the trailing signature
// and the unsigned one does not. PeerConnection / StorageManager
// dispatch off the type byte to the appropriate ingestor.

/**
 * Validate a deserialized JSON payload as a `BlockPayload` and build
 * the resulting Block. Returns null on shape mismatch (caller logs).
 */
function buildBlockAtom(
  payload: unknown,
  raw: Uint8Array,
  hash: Hash,
  signature: Uint8Array | undefined,
  signer: Uint8Array | undefined,
  source: AtomSource,
  packetType: PacketType.JsonSignedBlock | PacketType.JsonUnsignedBlock,
): Block | null {
  if (!isBlockPayload(payload)) return null;
  return createBlockFromPacket(payload, raw, hash, packetType, source, signature, signer);
}

function isBlockPayload(p: unknown): p is BlockPayload {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    o.anchor instanceof Hash &&
    Array.isArray(o.aggregates) &&
    Array.isArray(o.claims) &&
    Array.isArray(o.outputs) &&
    typeof o.declaredWeight === 'number' &&
    Array.isArray(o.refs)
  );
}

export const jsonSignedBlockIngestor = new JsonIngestor(
  PacketType.JsonSignedBlock,
  AtomType.Block,
  true,
  (payload, raw, hash, sig, signer, source) =>
    buildBlockAtom(payload, raw, hash, sig, signer, source, PacketType.JsonSignedBlock),
);

export const jsonUnsignedBlockIngestor = new JsonIngestor(
  PacketType.JsonUnsignedBlock,
  AtomType.Block,
  false,
  (payload, raw, hash, sig, signer, source) =>
    buildBlockAtom(payload, raw, hash, sig, signer, source, PacketType.JsonUnsignedBlock),
);
