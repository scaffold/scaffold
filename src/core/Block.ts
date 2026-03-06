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

/** Encode AggregationData to a Uint8Array for use in Output.data. */
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

/** Decode AggregationData from an Output.data Uint8Array. */
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
    if (Hash.equals(output.contract, AGGREGATION_CONTRACT)) {
      return decodeAggregationData(output.data);
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
    hashParts.push(out.contract.toBytes());
    hashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
    hashParts.push(out.data);
  }
  for (const idx of blueprint.claims) {
    hashParts.push(new Uint8Array(new Float64Array([idx]).buffer));
  }

  const hash = Hash.digestParts(...hashParts);

  const block: Block = {
    hash,
    anchor: blueprint.anchor,
    aggregates: blueprint.aggregates,
    claims: blueprint.claims,
    outputs: blueprint.outputs,
    declaredWeight: blueprint.declaredWeight,
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
    hashParts.push(out.contract.toBytes());
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
  };
}
