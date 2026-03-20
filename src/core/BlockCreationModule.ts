// Protocol spec: docs/protocol/block-creation.md, docs/protocol/contracts.md

import { Hash } from '../util/Hash.ts';
import { BitVector } from './BitVector.ts';

// -- Types --------------------------------------------------------

/** Verification contract reference: identifies the WASM contract and its parameters. */
export interface Verifier {
  /** Hash of the contract WASM. */
  contract: Hash;
  /** Contract-specific parameters. */
  params: Uint8Array;
}

/** A resource produced by a block. */
export interface Output {
  /** Verification contract that governs this output. */
  verifier: Verifier;
  /** Economic value. */
  value: number;
  /** Application-specific payload. */
  detail: Uint8Array;
}

/** A claim against an output in the extended vector. */
export interface ClaimEntry {
  /**
   * Index into the extended output vector:
   *   [own outputs (0..outputs.length-1), post-subtree surviving anchor outputs...]
   *
   * Indices < outputs.length are self-claims (produced and consumed atomically).
   */
  index: number;
  /** Economic value of the claimed output. */
  value: number;
}

/**
 * Input specification for building a block. Describes the creator's intent.
 * The module derives all structural fields (claimMask, weight vector, outputCount).
 */
export interface BlockSpec {
  /** Anchor block hash. */
  anchor: Hash;
  /** New outputs this block produces. */
  outputs: Output[];
  /** Claims against the extended output vector. */
  claims: ClaimEntry[];
  /** Declared computational work. */
  declaredWeight: number;
  /** Block hashes to aggregate (empty for leaf blocks). */
  aggregates: Hash[];
  /** Cross-block references for read-only data access. */
  refs: Hash[];
}

/**
 * Fully computed block ready for signing and distribution.
 * Contains the wire-format fields plus any generated contract outputs.
 */
export interface BlockBlueprint {
  anchor: Hash;
  aggregates: Hash[];
  claims: number[];
  /** All outputs: user-specified outputs + any generated contract outputs (e.g., aggregation). */
  outputs: Output[];
  declaredWeight: number;
  /** Cross-block references for read-only data access. */
  refs: Hash[];
}

/** Info about a subtree for weight vector derivation. */
export interface SubtreeInfo {
  /** Depth of the subtree's anchor relative to the aggregation block's anchor. */
  anchorDepth: number;
  /** The subtree's weight vector. */
  weightVector: number[];
}

// -- Provider -----------------------------------------------------

/**
 * Provider interface for the block creation module to access block data.
 * The module is fully encapsulated — it knows nothing about block internals
 * beyond what this interface exposes.
 */
export interface BlockCreationProvider<BlockType> {
  /** Return the block object for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the hash of a block. */
  getHash(block: BlockType): Hash;

  /** Return the anchor hash. ZERO_HASH for genesis. */
  getAnchor(block: BlockType): Hash;

  /** Return the total output count after all transformations. */
  getOutputCount(block: BlockType): number;

  /** Return the weight vector. */
  getWeightVector(block: BlockType): number[];

  /**
   * Return the depth of `ancestor` in the anchor chain starting from `from`.
   * depth 0 means from === ancestor's hash.
   * Returns undefined if `ancestor` is not in `from`'s anchor chain.
   */
  getAnchorDepth(from: Hash, ancestor: Hash): number | undefined;

  /**
   * Return the claim mask of `blockHash` rebased to `targetAnchor`.
   * Returns null if rebasing fails (chain broken, etc).
   */
  getRebasedClaimMask(blockHash: Hash, targetAnchor: Hash): BitVector | null;
}

// -- Module -------------------------------------------------------

/**
 * The block creation module constructs blocks from specs (intents).
 *
 * It validates structural constraints: throughput balancing (value
 * conservation), claim index range, inter-subtree conflict detection,
 * and anchor chain validity.
 *
 * Aggregation data (cache) is produced by the aggregation contract,
 * not by this module. See AggregationContract.ts.
 *
 * Fully self-contained — depends only on BlockCreationProvider, BitVector, and Hash.
 */
export class BlockCreationModule<BlockType> {
  private readonly provider: BlockCreationProvider<BlockType>;

  constructor(provider: BlockCreationProvider<BlockType>) {
    this.provider = provider;
  }

  // -- Public API -------------------------------------------------

  /**
   * Build a block from a spec. Derives all structural fields and validates
   * throughput balancing. Returns a blueprint ready for signing, or an error.
   */
  buildBlock(spec: BlockSpec): BlockBlueprint {
    // 1. Resolve anchor
    const anchorBlock = this.provider.getBlock(spec.anchor);
    if (!anchorBlock) {
      throw new Error('anchor block not found');
    }
    const anchorOutputCount = this.provider.getOutputCount(anchorBlock);

    // 2. Process subtrees (aggregation)
    const subtreeInfos: SubtreeInfo[] = [];
    const subtreeClaimMasks: BitVector[] = [];
    let totalSubtreeOutputs = 0;
    let subtreeAnchorClaims = 0;

    for (const aggHash of spec.aggregates) {
      const aggBlock = this.provider.getBlock(aggHash);
      if (!aggBlock) {
        throw new Error(`aggregated block not found: ${aggHash}`);
      }

      // Get anchor depth: distance between spec.anchor and aggregate's anchor.
      // Try both directions — the aggregate may anchor above or below spec.anchor.
      const aggAnchor = this.provider.getAnchor(aggBlock)!;
      let depth = this.provider.getAnchorDepth(spec.anchor, aggAnchor);
      if (depth === undefined) {
        depth = this.provider.getAnchorDepth(aggAnchor, spec.anchor);
      }
      if (depth === undefined) {
        throw new Error(`subtree anchor not in our anchor chain: ${aggHash}`);
      }

      // Get rebased claim mask
      const rebasedMask = this.provider.getRebasedClaimMask(aggHash, spec.anchor);
      if (!rebasedMask) {
        throw new Error(`cannot rebase subtree claim mask: ${aggHash}`);
      }

      const subtreeOutputCount = this.provider.getOutputCount(aggBlock);
      const subtreeWeightVector = this.provider.getWeightVector(aggBlock);

      subtreeInfos.push({ anchorDepth: depth, weightVector: subtreeWeightVector });
      subtreeClaimMasks.push(rebasedMask);
      totalSubtreeOutputs += subtreeOutputCount;
      subtreeAnchorClaims += rebasedMask.popcount();
    }

    // 3. Compute merged subtree claim mask (OR of all rebased masks)
    const mergedSubtreeMask = BitVector.empty(anchorOutputCount);
    for (const mask of subtreeClaimMasks) {
      mergedSubtreeMask.or(mask);
    }

    // Check for inter-subtree conflicts (two subtrees claim same anchor output)
    const subtreeClaimTotal = subtreeClaimMasks.reduce((s, m) => s + m.popcount(), 0);
    if (subtreeClaimTotal !== mergedSubtreeMask.popcount()) {
      throw new Error('subtrees have overlapping anchor claims (inter-subtree conflict)');
    }

    // 4. Validate and classify claims
    const ownOutputCount = spec.outputs.length;
    const extendedVectorLength = ownOutputCount +
      (anchorOutputCount - subtreeAnchorClaims + totalSubtreeOutputs);
    const selfClaims: number[] = [];
    const anchorClaims: number[] = [];

    for (const claim of spec.claims) {
      if (claim.index < 0) {
        throw new Error(`invalid claim index: ${claim.index}`);
      }
      if (claim.index >= extendedVectorLength) {
        throw new Error(
          `claim index ${claim.index} out of range (extended vector length: ${extendedVectorLength})`,
        );
      }
      if (claim.index < ownOutputCount) {
        selfClaims.push(claim.index);
      } else {
        anchorClaims.push(claim.index);
      }
    }

    // 5. Validate throughput
    this.validateThroughput(spec.claims, spec.outputs, ownOutputCount);

    // 9. Build blueprint
    const blueprint: BlockBlueprint = {
      anchor: spec.anchor,
      aggregates: spec.aggregates,
      claims: spec.claims.map((c) => c.index),
      outputs: spec.outputs,
      declaredWeight: spec.declaredWeight,
      refs: spec.refs,
    };

    return blueprint;
  }

  // -- Pure computations (exposed for testing) --------------------

  /**
   * Derive the weight vector from declaredWeight and subtree info.
   *
   * Leaf: [declaredWeight]
   * Aggregation: weight[d] = (d == 0 ? declaredWeight : 0)
   *              + sum(Si.weight[d - di] for each subtree Si where d >= di)
   */
  deriveWeightVector(
    declaredWeight: number,
    subtrees: SubtreeInfo[],
  ): number[] {
    if (subtrees.length === 0) {
      return [declaredWeight];
    }

    // Determine max depth needed
    let maxDepth = 0;
    for (const st of subtrees) {
      const stMaxDepth = st.anchorDepth + st.weightVector.length - 1;
      if (stMaxDepth > maxDepth) maxDepth = stMaxDepth;
    }

    const weight: number[] = new Array(maxDepth + 1).fill(0);
    weight[0] = declaredWeight;

    for (const st of subtrees) {
      for (let i = 0; i < st.weightVector.length; i++) {
        const d = st.anchorDepth + i;
        if (d < weight.length) {
          weight[d] += st.weightVector[i];
        }
      }
    }

    return weight;
  }

  /**
   * Validate throughput balancing: sum(claim values) == sum(output values).
   * Self-claims (index < ownOutputCount) net to zero.
   */
  validateThroughput(
    claims: ClaimEntry[],
    outputs: Output[],
    ownOutputCount: number,
  ): void {
    let claimTotal = 0;
    let selfClaimTotal = 0;
    for (const claim of claims) {
      if (claim.index < ownOutputCount) {
        selfClaimTotal += claim.value;
      } else {
        claimTotal += claim.value;
      }
    }

    let outputTotal = 0;
    let selfClaimedOutputTotal = 0;
    for (let i = 0; i < outputs.length; i++) {
      const isSelfClaimed = claims.some(
        (c) => c.index === i && i < ownOutputCount,
      );
      if (isSelfClaimed) {
        selfClaimedOutputTotal += outputs[i].value;
      } else {
        outputTotal += outputs[i].value;
      }
    }

    // Self-claims should balance internally
    if (selfClaimTotal !== selfClaimedOutputTotal) {
      throw new Error(
        `self-claim value mismatch: claimed ${selfClaimTotal}, output ${selfClaimedOutputTotal}`,
      );
    }

    // Non-self claims should balance with non-self-claimed outputs
    if (claimTotal !== outputTotal) {
      throw new Error(`throughput imbalance: inputs ${claimTotal}, outputs ${outputTotal}`);
    }
  }

}
