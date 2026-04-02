// Protocol spec: docs/protocol/block-creation.md (block structure), docs/protocol/contracts.md (standard contracts), docs/protocol/dag.md (graph topology)

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { BlockBlueprint, Output } from './BlockCreationModule.ts';

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

/** Well-known contract hash for result outputs (key-value store on a block). */
export const RESULT_CONTRACT = Hash.digest('result-contract');

/**
 * Create a signature (payment) contract output.
 * Public key goes in verifier.params (33-byte compressed secp256k1).
 */
export function makeSignatureOutput(publicKey: Uint8Array, value: number): Output {
  return {
    verifier: { contract: SIGNATURE_CONTRACT, params: publicKey },
    value,
    data: new Uint8Array(0),
  };
}

// -- AggregationData -----------------------------------------------

/**
 * Aggregation summary carried in an aggregation contract output's data field.
 * Contains the cached UTXO transformation state computed from subtrees.
 */
export interface AggregationData {
  /** Sorted anchor output indices claimed by the subtree. */
  claimMask: number[];
  /** Surviving new outputs added by this subtree (excludes anchor's surviving outputs). */
  newOutputCount: number;
  /** Per-subtree new output counts. */
  aggregateOutputCounts: number[];
  /** Weight vector from subtrees only (excludes own declaredWeight). */
  chainWeights: number[];
  /** Per-subtree declared weights. */
  aggregateWeights: number[];
}

/** Encode AggregationData to a Uint8Array for use in Output.data. */
export function encodeAggregationData(data: AggregationData): Uint8Array {
  const json = JSON.stringify({
    claimMask: data.claimMask,
    newOutputCount: data.newOutputCount,
    aggregateOutputCounts: data.aggregateOutputCounts,
    chainWeights: data.chainWeights,
    aggregateWeights: data.aggregateWeights,
  });
  return new TextEncoder().encode(json);
}

/** Decode AggregationData from an Output.data Uint8Array. */
export function decodeAggregationData(bytes: Uint8Array): AggregationData {
  const json = JSON.parse(new TextDecoder().decode(bytes));
  return {
    claimMask: json.claimMask as number[],
    newOutputCount: json.newOutputCount,
    aggregateOutputCounts: json.aggregateOutputCounts,
    chainWeights: json.chainWeights,
    aggregateWeights: json.aggregateWeights,
  };
}

/**
 * Find and decode the aggregation contract output from a block's outputs.
 * Returns null if the block has no aggregation contract output (leaf block).
 */
export function getAggregationData(block: Block): AggregationData | null {
  for (const output of block.outputs) {
    if (Hash.equals(output.verifier.contract, AGGREGATION_CONTRACT)) {
      if (output.data.length === 0) continue; // Skip marker outputs
      return decodeAggregationData(output.data);
    }
  }
  return null;
}

/**
 * Create an aggregation marker output. Every non-genesis block carries one
 * of these so that the aggregation contract can collect them.
 */
export function makeAggregationOutput(): Output {
  return {
    verifier: { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
    value: 0,
    data: new Uint8Array(0),
  };
}

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

// -- Collateral types -----------------------------------------------

/** What aspect of a block an AGAINST challenge contests. */
export type ChallengeTarget =
  | { type: 'validity' }
  | { type: 'anchor' }
  | { type: 'ref'; index: number }
  | { type: 'aggregate'; index: number }
  | { type: 'output_verifier_contract'; index: number };

/** Detail payload for a collateral contract output. */
export type CollateralDetail =
  | { side: 'for'; pubkey: Uint8Array }
  | { side: 'against'; pubkey: Uint8Array; target: ChallengeTarget };

/** Detail payload for an insurance contract output. */
export interface InsuranceDetail {
  pubkey: Uint8Array;
}

/** Encode CollateralDetail to Uint8Array. */
export function encodeCollateralDetail(detail: CollateralDetail): Uint8Array {
  const obj: Record<string, unknown> = {
    side: detail.side,
    pubkey: Array.from(detail.pubkey),
  };
  if (detail.side === 'against') {
    obj.target = detail.target;
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** Decode CollateralDetail from Uint8Array. */
export function decodeCollateralDetail(bytes: Uint8Array): CollateralDetail {
  const json = JSON.parse(new TextDecoder().decode(bytes));
  const pubkey = new Uint8Array(json.pubkey);
  if (json.side === 'for') {
    return { side: 'for', pubkey };
  }
  return { side: 'against', pubkey, target: json.target as ChallengeTarget };
}

/** Encode InsuranceDetail to Uint8Array. */
export function encodeInsuranceDetail(detail: InsuranceDetail): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ pubkey: Array.from(detail.pubkey) }));
}

/** Decode InsuranceDetail from Uint8Array. */
export function decodeInsuranceDetail(bytes: Uint8Array): InsuranceDetail {
  const json = JSON.parse(new TextDecoder().decode(bytes));
  return { pubkey: new Uint8Array(json.pubkey) };
}

/** Create a FOR collateral output for a target block. */
export function makeCollateralOutput(
  targetBlockHash: Hash,
  value: number,
  pubkey: Uint8Array,
): Output {
  return {
    verifier: { contract: COLLATERAL_CONTRACT, params: targetBlockHash.toBytes() },
    value,
    data: encodeCollateralDetail({ side: 'for', pubkey }),
  };
}

/** Create an AGAINST collateral output challenging a target block. */
export function makeAgainstOutput(
  targetBlockHash: Hash,
  value: number,
  pubkey: Uint8Array,
  target: ChallengeTarget,
): Output {
  return {
    verifier: { contract: COLLATERAL_CONTRACT, params: targetBlockHash.toBytes() },
    value,
    data: encodeCollateralDetail({ side: 'against', pubkey, target }),
  };
}

/** Create an insurance deposit output for a target block. */
export function makeInsuranceOutput(
  targetBlockHash: Hash,
  value: number,
  pubkey: Uint8Array,
): Output {
  return {
    verifier: { contract: INSURANCE_CONTRACT, params: targetBlockHash.toBytes() },
    value,
    data: encodeInsuranceDetail({ pubkey }),
  };
}

// -- Block metadata -------------------------------------------------

/** How a block was received at this node. */
export enum BlockSource {
  Local = 'local',
  Remote = 'remote',
  Storage = 'storage',
}

// -- Block interface ------------------------------------------------

/**
 * Concrete block type: wire format + computed hash + reception metadata.
 * Domain-specific data (aggregation state, collateral, payment) is
 * carried in contract outputs within the outputs array.
 */
export interface Block {
  readonly hash: Hash;
  readonly anchor: Hash;
  readonly aggregates: Hash[];
  readonly claims: number[];
  readonly outputs: Output[];
  readonly declaredWeight: number;
  /** Cross-block references for read-only data access. */
  readonly refs: Hash[];
  /** Resolved claims -- concrete output references for uniform claim handling. */
  readonly resolvedClaims?: import('./BlockDraft.ts').ResolvedClaim[];
  /** Compressed public key (33 bytes) of the block signer. Node-local, not serialized. */
  readonly signer?: Uint8Array;
  /** Creation time, set by block creator (wire format). */
  readonly timestamp: number;
  /** Reception time at this node (Date.now()). Node-local, not serialized. */
  readonly receivedAt: number;
  /** How this block was received. Node-local, not serialized. */
  readonly source: BlockSource;
}

// -- BlockStore -----------------------------------------------------

/** In-memory block store with structural queries. */
export class BlockStore {
  private readonly blocks = new Map<HashPrimitive, Block>();
  private readonly aggregated = new Set<HashPrimitive>();

  get(hash: Hash): Block | undefined {
    return this.blocks.get(hash.toPrimitive());
  }

  put(block: Block): void {
    this.blocks.set(block.hash.toPrimitive(), block);

    // Track which blocks get aggregated
    for (const agg of block.aggregates) {
      this.aggregated.add(agg.toPrimitive());
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

// -- Self-claim and ref helpers -------------------------------------

/**
 * Create a result output. Result outputs use the RESULT_CONTRACT
 * verifier with the key encoded in params. They act as a key-value store
 * within a block.
 */
export function createSelfClaimedOutput(key: string | Uint8Array, value: Uint8Array): Output {
  const params = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  return {
    verifier: { contract: RESULT_CONTRACT, params },
    value: 0,
    data: value,
  };
}

/** Check whether an output is a result output (uses RESULT_CONTRACT). */
export function isResultOutput(output: Output): boolean {
  return Hash.equals(output.verifier.contract, RESULT_CONTRACT);
}

/** Get the key from a result output's verifier params. */
export function getResultKey(output: Output): Uint8Array {
  return output.verifier.params;
}

/** Find the first result output in a block matching the given key. */
export function findResultOutput(block: Block, key: string | Uint8Array): Output | undefined {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  for (const output of block.outputs) {
    if (!isResultOutput(output)) continue;
    const params = output.verifier.params;
    if (params.length === keyBytes.length && params.every((b, i) => b === keyBytes[i])) {
      return output;
    }
  }
  return undefined;
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

/** Block fields minus hash and node-local metadata -- the payload carried in a Packet. */
export type BlockPayload = Omit<Block, 'hash' | 'receivedAt' | 'source' | 'signer'>;

/** Construct a Block from a deserialized packet payload and a precomputed hash. */
export function createBlockFromPacket(
  payload: BlockPayload,
  hash: Hash,
  source: BlockSource = BlockSource.Remote,
  signer?: Uint8Array,
): Block {
  const now = Date.now();
  return {
    hash,
    anchor: payload.anchor,
    aggregates: payload.aggregates,
    claims: payload.claims,
    outputs: payload.outputs,
    declaredWeight: payload.declaredWeight,
    refs: payload.refs,
    signer,
    timestamp: payload.timestamp ?? now,
    receivedAt: now,
    source,
  };
}

// -- Factory functions ----------------------------------------------

/**
 * Create a Block from a BlockBlueprint and the resolved anchor block.
 * Computes the hash by digesting a canonical representation of the block data.
 */
export function createBlock(
  blueprint: BlockBlueprint,
  anchorBlock: Block,
): Block {
  // Compute a deterministic hash from block contents
  const hashParts: Uint8Array[] = [
    blueprint.anchor.toBytes(),
    ...blueprint.aggregates.map((a) => a.toBytes()),
    new Uint8Array(new Float64Array([blueprint.declaredWeight]).buffer),
  ];
  for (const out of blueprint.outputs) {
    hashParts.push(out.verifier.contract.toBytes());
    hashParts.push(out.verifier.params);
    hashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
    hashParts.push(out.data);
  }
  for (const idx of blueprint.claims) {
    hashParts.push(new Uint8Array(new Float64Array([idx]).buffer));
  }
  for (const ref of blueprint.refs) {
    hashParts.push(ref.toBytes());
  }

  const hash = Hash.digestParts(...hashParts);

  const block: Block = {
    hash,
    anchor: blueprint.anchor,
    aggregates: blueprint.aggregates,
    claims: blueprint.claims,
    outputs: blueprint.outputs,
    declaredWeight: blueprint.declaredWeight,
    refs: blueprint.refs,
    timestamp: Date.now(),
    receivedAt: Date.now(),
    source: BlockSource.Local,
  };

  return block;
}

/**
 * Create a genesis block with the given outputs.
 * Genesis blocks have no anchor and no claims.
 */
export function createGenesisBlock(outputs: Output[]): Block {
  const hashParts: Uint8Array[] = [
    new Uint8Array([0]), // genesis marker
  ];
  for (const out of outputs) {
    hashParts.push(out.verifier.contract.toBytes());
    hashParts.push(out.verifier.params);
    hashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
    hashParts.push(out.data);
  }
  const hash = Hash.digestParts(...hashParts);

  return {
    hash,
    anchor: ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs,
    declaredWeight: GENESIS_WEIGHT,
    refs: [],
    timestamp: Date.now(),
    receivedAt: Date.now(),
    source: BlockSource.Local,
  };
}
