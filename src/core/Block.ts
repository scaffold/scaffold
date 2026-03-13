// Protocol spec: docs/protocol/block-creation.md (block structure), docs/protocol/contracts.md (standard contracts), docs/protocol/dag.md (graph topology)

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { BitVector } from './BitVector.ts';
import { BlockBlueprint, Output } from './BlockCreationModule.ts';

/** Genesis blocks use this as their declared weight (very high). */
export const GENESIS_WEIGHT = Number.MAX_SAFE_INTEGER;

/** Well-known contract hash for aggregation contract outputs. */
export const AGGREGATION_CONTRACT = Hash.digest('aggregation-contract');

/** Well-known contract hash for collateral contract outputs. */
export const COLLATERAL_CONTRACT = Hash.digest('collateral-contract');

/** Well-known contract hash for signature (payment) contract outputs. */
export const SIGNATURE_CONTRACT = Hash.digest('signature-contract');

/** Well-known contract hash for self-claimed outputs (key-value store). */
export const SELF_CONTRACT = Hash.digest('self-contract');

// -- AggregationData -----------------------------------------------

/**
 * Aggregation summary carried in an aggregation contract output's data field.
 * Contains the cached UTXO transformation state computed from subtrees.
 */
export interface AggregationData {
  /** Composed claim mask from subtrees (rebased + merged + own claims). */
  claimMask: BitVector;
  /** Total outputs after full transformation. */
  outputCount: number;
  /** Per-subtree output counts. */
  aggregateOutputCounts: number[];
  /** Weight vector from subtrees only (excludes own declaredWeight). */
  chainWeights: number[];
  /** Per-subtree declared weights. */
  aggregateWeights: number[];
}

/** Encode AggregationData to a Uint8Array for use in Output.detail. */
export function encodeAggregationData(data: AggregationData): Uint8Array {
  const json = JSON.stringify({
    claimMask: data.claimMask.toJSON(),
    outputCount: data.outputCount,
    aggregateOutputCounts: data.aggregateOutputCounts,
    chainWeights: data.chainWeights,
    aggregateWeights: data.aggregateWeights,
  });
  return new TextEncoder().encode(json);
}

/** Decode AggregationData from an Output.detail Uint8Array. */
export function decodeAggregationData(bytes: Uint8Array): AggregationData {
  const json = JSON.parse(new TextDecoder().decode(bytes));
  return {
    claimMask: BitVector.fromJSON(json.claimMask),
    outputCount: json.outputCount,
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
      return decodeAggregationData(output.detail);
    }
  }
  return null;
}

/**
 * Get the claim mask for a block: from aggregation data if present,
 * otherwise computed from claims for leaf blocks.
 * For leaf blocks, requires the anchor block to determine the anchor output count.
 * Returns null if insufficient data is available.
 */
export function getBlockClaimMask(block: Block, anchorOutputCount: number): BitVector {
  const aggData = getAggregationData(block);
  if (aggData) return aggData.claimMask;
  // Leaf block: compute from own claims
  const ownOutputCount = block.outputs.length;
  const mask = BitVector.empty(anchorOutputCount);
  for (const claimIdx of block.claims) {
    if (claimIdx >= ownOutputCount) {
      // Map to anchor output index: claim targets surviving anchor output
      const anchorIdx = claimIdx - ownOutputCount;
      if (anchorIdx < anchorOutputCount) {
        mask.set(anchorIdx, true);
      }
    }
  }
  return mask;
}

/**
 * Get the output count for a block: from aggregation data if present,
 * otherwise derived as a leaf block.
 */
export function getBlockOutputCount(block: Block): number {
  const aggData = getAggregationData(block);
  if (aggData) return aggData.outputCount;
  // Leaf block or genesis: anchor's output count - own claims + own outputs
  // For genesis: outputs.length
  // For leaf blocks without aggregation data, we need the anchor's output count
  // which we don't have here. This function is only valid when aggData exists
  // or for genesis blocks.
  return block.outputs.length;
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
 * Concrete block type: wire format + computed hash.
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
 * Create a self-claimed output. Self-claimed outputs use the SELF_CONTRACT
 * verifier with the key encoded in params. They act as a key-value store
 * within a block.
 */
export function createSelfClaimedOutput(key: string | Uint8Array, value: Uint8Array): Output {
  const params = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  return {
    verifier: { contract: SELF_CONTRACT, params },
    value: 0,
    detail: value,
  };
}

/** Check whether an output is a self-claimed output (uses SELF_CONTRACT). */
export function isSelfClaimed(output: Output): boolean {
  return Hash.equals(output.verifier.contract, SELF_CONTRACT);
}

/** Get the key from a self-claimed output's verifier params. */
export function getSelfClaimKey(output: Output): Uint8Array {
  return output.verifier.params;
}

/** Find the first self-claimed output in a block matching the given key. */
export function findSelfClaimedOutput(block: Block, key: string | Uint8Array): Output | undefined {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  for (const output of block.outputs) {
    if (!isSelfClaimed(output)) continue;
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
export function getRefOutputs(block: Block, refIndex: number, store: BlockStore): Output[] | undefined {
  if (refIndex < 0 || refIndex >= block.refs.length) return undefined;
  const refHash = block.refs[refIndex];
  const refBlock = store.get(refHash);
  if (!refBlock) return undefined;
  return refBlock.outputs;
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
    hashParts.push(out.detail);
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
    hashParts.push(out.detail);
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
  };
}
