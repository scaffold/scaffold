// Protocol spec: docs/protocol/block-creation.md (block structure), docs/protocol/contracts.md (standard contracts), docs/protocol/dag.md (graph topology)

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { Output } from './BlockCreationModule.ts';
import { AtomBase, AtomSource, AtomType } from './Atom.ts';
import { PacketType, parseHeader } from './Packet.ts';
import { JsonSerializer } from './PacketSerializer.ts';
import type { ClaimRef, Node } from './Node.ts';

// Re-export Atom types for callers that pull `Block` and source/kind
// constants together. Keeps test fixtures compact.
export { AtomSource, AtomType } from './Atom.ts';

/** Genesis blocks use this as their declared weight (very high). */
export const GENESIS_WEIGHT = Number.MAX_SAFE_INTEGER;

/** Well-known contract hash for contracts themselves. */
export const CONTRACT_CONTRACT = Hash.digest('contract-contract');

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
 * Well-known contract hash for content-addressed blob lookup. A HASH_CONTRACT
 * verifier's params are a 32-byte blob hash; the block carrying the contract
 * provides a `preimage` record whose body, when hashed, must equal those
 * params. See docs/protocol/wasm-abi.md#stacking (used by WASM stacking to
 * fetch layer blobs by content hash).
 */
export const HASH_CONTRACT = Hash.digest('hash-contract');

/**
 * Well-known contract hash for the chess-demo game-state contract. Lives in
 * core so tests and services can reference a stable hash without depending on
 * the demo module.
 */
export const GAME_STATE_CONTRACT = Hash.digest('chess-game-state-contract');

import { getAggregationData } from '../contracts/AggregationContract.ts';
import {
  type OutputSpaceBlock,
  OutputSpaceModule,
  type OutputSpaceProvider,
} from './OutputSpace.ts';

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
  for (const claimIdx of block.claimIndices) {
    if (claimIdx >= ownOutputCount) {
      mask.push(claimIdx - ownOutputCount);
    }
  }
  mask.sort((a, b) => a - b);
  return mask;
}

/**
 * The block's *aggregated subtree's* contribution at each anchor depth --
 * i.e., `aggData.chainWeights` if present, else `[]`. Does NOT include the
 * block's own `declaredWeight`. This is the "split" form consumed by
 * `NodeWeightsModule` and any caller that needs `selfWeight` and subtree
 * contribution as distinct inputs.
 */
export function getBlockWeightVector(block: Block): number[] {
  const aggData = getAggregationData(block);
  return aggData ? [...aggData.chainWeights] : [];
}

/**
 * The block's full per-depth weight: `declaredWeight` folded into entry 0,
 * subtree contributions on top. This is the "rolled-up" form consumed by
 * `ConsensusModule` (which sums per-depth verified weight) and by
 * `BlockCreationModule.deriveWeightVector` (which composes subtrees by their
 * total contribution including their own declared weight).
 */
export function getBlockTotalWeightVector(block: Block): number[] {
  const subtree = getBlockWeightVector(block);
  if (subtree.length === 0) return [block.declaredWeight];
  const result = [...subtree];
  result[0] += block.declaredWeight;
  return result;
}

// -- BlockPayload (wire-encoded fields) -----------------------------

/**
 * The wire-serialized fields of a block. This is the JSON payload
 * carried inside a packet -- everything before the optional trailing
 * signature. `Block` extends both `AtomBase` (wire identity + reception
 * metadata) and `BlockPayload` (consensus fields). Keeping `BlockPayload`
 * as its own interface, rather than `Omit<Block, ...>`, means the wire
 * shape is stated explicitly and node-local fields stay separate.
 */
export interface BlockPayload {
  readonly anchor: Hash;
  readonly aggregates: Hash[];
  /**
   * Sorted indices into this block's extended vector identifying the
   * outputs this block consumes. The extended vector is
   * `[ownOutputs..., aggregateOutputs..., anchorSurvivingOutputs...]`.
   *
   * This is the wire-format claim representation; the canonical Node-level
   * claim form is the upcoming `Block.claims: ClaimRef[]`, which carries
   * direct `(producer, outputIndex)` references.
   */
  readonly claimIndices: number[];
  readonly outputs: Output[];
  readonly declaredWeight: number;
  /** Cross-block references for read-only data access. */
  readonly refs: Hash[];
  /** Creation time, set by block creator at build time. */
  readonly timestamp: number;
}

// -- Block interface ------------------------------------------------

/**
 * Concrete block type: an Atom whose payload carries the consensus
 * fields. Wire identity and reception metadata come from `AtomBase`;
 * the consensus fields come from `BlockPayload`; the unified graph-vertex
 * surface (used by ConsensusModule, OutputClaimModule, weight propagation)
 * comes from `Node`.
 *
 * The optional fields (`selfWeight`, `subtreeWeight`) are node-local and
 * never serialized.
 */
export interface Block extends AtomBase, BlockPayload, Node {
  /** Discriminator for the `Atom` union. */
  readonly type: AtomType.Block;
  /** Block packets are JSON-encoded today; binary encodings will join later. */
  readonly packetType: PacketType.JsonSignedBlock | PacketType.JsonUnsignedBlock;

  /** Discriminator for the `Node` union. */
  readonly kind: 'block';

  /**
   * Direct `(producer, outputIndex)` references for every input this block
   * consumes, parallel to `claimIndices`. At construction each entry is
   * `{ producer: this.hash, outputIndex: claimIndices[i] }` -- the claim
   * targets a position in this block's own extended vector. As ancestors
   * become canonical, OutputClaimModule.tryMigrate rewrites these in place,
   * eventually pointing each entry directly at the producing block's own
   * outputs (where `outputIndex < producer.outputs.length`). See
   * `Node.claims` for the full semantics.
   */
  readonly claims: ClaimRef[];

  /**
   * Live, sampled weight used by ConsensusModule to pick the canonical
   * subgraph. Initialized to `declaredWeight`; refined by the sampling
   * subsystem as descendant subtree weight is observed.
   */
  effectiveWeight: number;

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
 * Build an `OutputSpaceModule` over a `BlockStore`. The single shared
 * factory used by every site that needs to resolve claim indices --
 * `UtxoIndex`, `ContractVerificationService`, `GenerationService`,
 * `NodeContext.autoBalance`. Earlier code hand-rolled an `Output[]`
 * walk via the now-removed `collectExtendedOutputs`, which silently
 * lost self-claims and aggregate subtree outputs and produced wrong
 * results for any block with self-claims (chess RECORD/"game") or
 * aggregates (chess agg block). Always go through this.
 */
export function makeBlockStoreOutputSpace(store: BlockStore): OutputSpaceModule {
  const provider: OutputSpaceProvider = {
    getBlock(hash: Hash): OutputSpaceBlock | undefined {
      const block = store.get(hash);
      if (!block) return undefined;
      const aggData = getAggregationData(block);
      const sc = block.claimIndices.filter((c) => c < block.outputs.length).length;
      return {
        hash: block.hash,
        anchor: block.anchor,
        aggregates: block.aggregates,
        outputs: block.outputs.map((o) => ({ value: o.value })),
        claimIndices: [...block.claimIndices].sort((a, b) => a - b),
        aggregateOutputCounts: aggData?.aggregateOutputCounts ?? [],
        newOutputCount: aggData?.newOutputCount ?? (block.outputs.length - sc),
      };
    },
  };
  return new OutputSpaceModule(provider);
}

/**
 * Resolve a single claim index in `block`'s extended vector to the
 * concrete `{producerBlock, output}` it points at. Convenience wrapper
 * for callers that just need the output object (UtxoIndex, contract
 * envs).
 */
export function resolveClaimToOutput(
  block: Block,
  claimIndex: number,
  store: BlockStore,
  outputSpace?: OutputSpaceModule,
): { block: Block; outputIndex: number; output: Output } | undefined {
  const space = outputSpace ?? makeBlockStoreOutputSpace(store);
  const target = space.resolveClaimIndex(block.hash, claimIndex);
  if (!target) return undefined;
  const producer = store.get(target.block);
  if (!producer) return undefined;
  const output = producer.outputs[target.outputIndex];
  if (!output) return undefined;
  return { block: producer, outputIndex: target.outputIndex, output };
}

/**
 * Walk `block`'s extended vector position by position, yielding the
 * concrete output and its producing source for each index. Stops as
 * soon as resolution fails (end of vector or unreachable subtree).
 *
 * Use sparingly: search-by-content over the extended vector is
 * O(extendedVectorLength) per call. For known producers prefer
 * `OutputSpaceModule.computeClaimIndex`.
 */
export function* iterateExtendedOutputs(
  block: Block,
  store: BlockStore,
  outputSpace?: OutputSpaceModule,
): Generator<
  { extendedIndex: number; output: Output; source: { block: Hash; outputIndex: number } }
> {
  const space = outputSpace ?? makeBlockStoreOutputSpace(store);
  for (let i = 0;; i++) {
    const target = space.resolveClaimIndex(block.hash, i);
    if (!target) return;
    const producer = store.get(target.block);
    if (!producer) return;
    const output = producer.outputs[target.outputIndex];
    if (!output) return;
    yield { extendedIndex: i, output, source: target };
  }
}

// -- Construct from parsed payload + wire metadata -------------------

/**
 * Construct a Block from a deserialized payload plus the wire-form
 * fields (raw bytes, hash, optional signature/signer). The block
 * serializers (`jsonSignedBlockSerializer` / `jsonUnsignedBlockSerializer`)
 * call this through the `AtomBuilder` callback during deserialize.
 */
export function createBlockFromPacket(
  payload: BlockPayload,
  raw: Uint8Array,
  hash: Hash,
  packetType: PacketType.JsonSignedBlock | PacketType.JsonUnsignedBlock,
  source: AtomSource = AtomSource.Remote,
  signature?: Uint8Array,
  signer?: Uint8Array,
): Block {
  // Initial Node-projection claims: each ClaimRef points at this block's
  // own extended vector. OutputClaimModule.tryMigrate rewrites them as
  // ancestors become canonical, eventually replacing `producer` with the
  // deepest block whose own outputs contain the target.
  const claims: ClaimRef[] = payload.claimIndices.map((outputIndex) => ({
    producer: hash,
    outputIndex,
  }));
  return {
    hash,
    type: AtomType.Block,
    packetType,
    raw,
    signature,
    signer,
    source,
    receivedAt: Date.now(),
    fromConnections: [],
    toConnections: new Set(),
    anchor: payload.anchor,
    aggregates: payload.aggregates,
    claimIndices: payload.claimIndices,
    outputs: payload.outputs,
    declaredWeight: payload.declaredWeight,
    refs: payload.refs,
    timestamp: payload.timestamp,
    kind: 'block',
    claims,
    effectiveWeight: payload.declaredWeight,
  };
}

// -- Compose helpers -------------------------------------------------
//
// Block-specific compose helpers live here (not in Packet.ts) so that
// `createBlock` / `createGenesisBlock` can reuse them without a
// Block.ts <-> Packet.ts import cycle. They are thin wrappers around
// the JSON serializers exported below.

/** Compose a signed block packet and return the resulting Block. */
export function composeBlockPacket(payload: BlockPayload, privateKey: Uint8Array): Block {
  return jsonSignedBlockSerializer.serialize(payload, AtomSource.Local, privateKey) as Block;
}

/** Compose an unsigned block packet and return the resulting Block. */
export function composeUnsignedBlockPacket(payload: BlockPayload): Block {
  return jsonUnsignedBlockSerializer.serialize(payload, AtomSource.Local) as Block;
}

/** Compose a genesis block (unsigned, fixed-shape payload). */
export function composeGenesisPacket(outputs: Output[]): Block {
  return composeUnsignedBlockPacket({
    anchor: ZERO_HASH,
    aggregates: [],
    claimIndices: [],
    outputs,
    declaredWeight: GENESIS_WEIGHT,
    refs: [],
    timestamp: 0,
  });
}

// -- Factory functions ----------------------------------------------

/**
 * Test-friendly helper that composes an unsigned block packet from a
 * payload. Takes the resolved anchor block as a parameter for legacy
 * call-site signature compatibility (the parameter is unused -- the
 * payload already carries the anchor hash).
 */
export function createBlock(payload: BlockPayload, _anchorBlock: Block): Block {
  return composeUnsignedBlockPacket(payload);
}

/**
 * Create a genesis block with the given outputs. Hash and raw bytes
 * derive from the wire encoding so all Blocks satisfy
 * `Hash.digest(block.raw) === block.hash`.
 */
export function createGenesisBlock(outputs: Output[]): Block {
  return composeGenesisPacket(outputs);
}

// -- Block serializers -----------------------------------------------
//
// One JsonSerializer per block PacketType. Both produce `AtomType.Block`;
// the signed instance reads/writes the trailing signature and recovers
// the signer, and the unsigned one does not. PeerConnection /
// StorageManager dispatch off the type byte to the appropriate serializer.

function isBlockPayload(p: unknown): p is BlockPayload {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    o.anchor instanceof Hash &&
    Array.isArray(o.aggregates) &&
    Array.isArray(o.claimIndices) &&
    Array.isArray(o.outputs) &&
    typeof o.declaredWeight === 'number' &&
    Array.isArray(o.refs) &&
    typeof o.timestamp === 'number'
  );
}

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

export const jsonSignedBlockSerializer = new JsonSerializer<BlockPayload>(
  PacketType.JsonSignedBlock,
  AtomType.Block,
  true,
  (payload, raw, hash, sig, signer, source) =>
    buildBlockAtom(payload, raw, hash, sig, signer, source, PacketType.JsonSignedBlock),
);

export const jsonUnsignedBlockSerializer = new JsonSerializer<BlockPayload>(
  PacketType.JsonUnsignedBlock,
  AtomType.Block,
  false,
  (payload, raw, hash, sig, signer, source) =>
    buildBlockAtom(payload, raw, hash, sig, signer, source, PacketType.JsonUnsignedBlock),
);

// -- Block packet dispatch ------------------------------------------

/**
 * Parse raw bytes as a block packet (signed or unsigned), routing on
 * the type byte. Returns null on bad magic, non-block type, malformed
 * payload, or signer-recovery failure for signed blocks. If
 * `fromPeerId` is provided, it is recorded as `fromConnections[0]` --
 * the reverse-path target for hash-addressed signaling.
 */
export function parseBlockPacket(
  raw: Uint8Array,
  source: AtomSource,
  fromPeerId?: string,
): Block | null {
  const header = parseHeader(raw);
  if (!header) return null;
  let block: Block | null = null;
  if (header.type === PacketType.JsonSignedBlock) {
    block = jsonSignedBlockSerializer.deserialize(raw, source) as Block | null;
  } else if (header.type === PacketType.JsonUnsignedBlock) {
    block = jsonUnsignedBlockSerializer.deserialize(raw, source) as Block | null;
  }
  if (block && fromPeerId !== undefined) block.fromConnections.push(fromPeerId);
  return block;
}
