// Protocol spec: docs/protocol/block-creation.md (block structure), docs/protocol/dag.md (graph topology)

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { BitVector } from './BitVector.ts';
import { BlockBlueprint, Output } from './BlockCreationModule.ts';

/** Genesis blocks use this as their declared weight (very high). */
export const GENESIS_WEIGHT = Number.MAX_SAFE_INTEGER;

// -- Block interface ------------------------------------------------

/** Concrete block type with all fields needed by every provider. */
export interface Block {
  // Structural
  readonly hash: Hash;
  readonly anchor: Hash;
  readonly aggregates: Hash[];
  readonly claimMask: BitVector;
  readonly subtreeClaimMask: BitVector | null;
  readonly ownOutputCount: number;
  readonly outputCount: number;
  readonly anchorOutputCount: number;
  readonly aggregateOutputCounts: number[];
  readonly claims: number[];
  readonly outputs: Output[];

  // Weight
  readonly declaredWeight: number;
  readonly weightVector: number[];

  // Gossip
  readonly size: number;
  readonly collateralTarget: Hash | undefined;
  readonly paymentTarget: string | undefined;

  // Trust
  readonly childDeclaredWeights: number[];
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
 * Create a Block from a BlockBlueprint, the resolved anchor block, and extras.
 * Computes the hash by digesting a canonical representation of the block data.
 */
export function createBlock(
  blueprint: BlockBlueprint,
  anchorBlock: Block,
  extras?: {
    collateralTarget?: Hash;
    paymentTarget?: string;
  },
): Block {
  const anchorOutputCount = anchorBlock.outputCount;

  // Compute child declared weights from aggregates
  const childDeclaredWeights: number[] = [];
  // For now, each aggregate's weight[0] is its declared weight contribution
  // The parent stores what it claims each child contributes

  // Compute a deterministic hash from block contents
  const hashParts: Uint8Array[] = [
    blueprint.anchor.toBytes(),
    ...blueprint.aggregates.map((a) => a.toBytes()),
    new Uint8Array(new Float64Array([blueprint.declaredWeight]).buffer),
    new Uint8Array(new Float64Array([blueprint.outputCount]).buffer),
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

  // Estimate size (rough serialization size)
  let size = 32 + 32; // hash + anchor
  size += blueprint.aggregates.length * 32; // aggregate hashes
  size += blueprint.claims.length * 4; // claim indices
  for (const out of blueprint.outputs) {
    size += 32 + 8 + out.data.length; // contract hash + value + data
  }
  size += blueprint.weight.length * 8; // weight vector

  const block: Block = {
    hash,
    anchor: blueprint.anchor,
    aggregates: blueprint.aggregates,
    claimMask: blueprint.claimMask,
    subtreeClaimMask: blueprint.subtreeClaimMask,
    ownOutputCount: blueprint.ownOutputCount,
    outputCount: blueprint.outputCount,
    anchorOutputCount,
    aggregateOutputCounts: blueprint.aggregateOutputCounts,
    claims: blueprint.claims,
    outputs: blueprint.outputs,
    declaredWeight: blueprint.declaredWeight,
    weightVector: blueprint.weight,
    size,
    collateralTarget: extras?.collateralTarget,
    paymentTarget: extras?.paymentTarget,
    childDeclaredWeights,
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

  let size = 32;
  for (const out of outputs) {
    size += 32 + 8 + out.data.length;
  }

  return {
    hash,
    anchor: ZERO_HASH,
    aggregates: [],
    claimMask: BitVector.empty(0),
    subtreeClaimMask: null,
    ownOutputCount: outputs.length,
    outputCount: outputs.length,
    anchorOutputCount: 0,
    aggregateOutputCounts: [],
    claims: [],
    outputs,
    declaredWeight: GENESIS_WEIGHT,
    weightVector: [],
    size,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };
}
