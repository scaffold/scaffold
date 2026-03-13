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

/** Result of attempting to build a block. */
export type BuildResult =
  | { ok: true; blueprint: BlockBlueprint }
  | { ok: false; error: string };

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

  /** Return the aggregation contract hash for generated outputs. */
  getAggregationContract(): Hash;
}

// -- Module -------------------------------------------------------

/**
 * The block creation module constructs blocks from specs (intents).
 *
 * It derives all structural fields: claim masks, weight vectors, output counts,
 * and aggregate output counts. It validates throughput balancing (value
 * conservation) and structural constraints.
 *
 * For aggregation blocks, it produces an aggregation contract output containing
 * the computed AggregationData (claim mask, output count, chain weights, etc.).
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
  buildBlock(spec: BlockSpec): BuildResult {
    // 1. Resolve anchor
    const anchorBlock = this.provider.getBlock(spec.anchor);
    if (!anchorBlock) {
      return { ok: false, error: 'anchor block not found' };
    }
    const anchorOutputCount = this.provider.getOutputCount(anchorBlock);

    // 2. Process subtrees (aggregation)
    const subtreeInfos: SubtreeInfo[] = [];
    const aggregateOutputCounts: number[] = [];
    const subtreeClaimMasks: BitVector[] = [];
    const aggregateWeights: number[] = [];
    let totalSubtreeOutputs = 0;
    let subtreeAnchorClaims = 0;

    for (const aggHash of spec.aggregates) {
      const aggBlock = this.provider.getBlock(aggHash);
      if (!aggBlock) {
        return { ok: false, error: `aggregated block not found: ${aggHash}` };
      }

      // Get anchor depth of subtree relative to our anchor
      const depth = this.provider.getAnchorDepth(spec.anchor, this.provider.getAnchor(aggBlock)!);
      if (depth === undefined) {
        return { ok: false, error: `subtree anchor not in our anchor chain: ${aggHash}` };
      }

      // Get rebased claim mask
      const rebasedMask = this.provider.getRebasedClaimMask(aggHash, spec.anchor);
      if (!rebasedMask) {
        return { ok: false, error: `cannot rebase subtree claim mask: ${aggHash}` };
      }

      const subtreeOutputCount = this.provider.getOutputCount(aggBlock);
      const subtreeWeightVector = this.provider.getWeightVector(aggBlock);

      subtreeInfos.push({ anchorDepth: depth, weightVector: subtreeWeightVector });
      aggregateOutputCounts.push(subtreeOutputCount);
      subtreeClaimMasks.push(rebasedMask);
      aggregateWeights.push(subtreeWeightVector[0] ?? 0);
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
      return {
        ok: false,
        error: 'subtrees have overlapping anchor claims (inter-subtree conflict)',
      };
    }

    // 4. Validate and classify claims
    const ownOutputCount = spec.outputs.length;
    const extendedVectorLength = ownOutputCount +
      (anchorOutputCount - subtreeAnchorClaims + totalSubtreeOutputs);
    const selfClaims: number[] = [];
    const anchorClaims: number[] = [];

    for (const claim of spec.claims) {
      if (claim.index < 0) {
        return { ok: false, error: `invalid claim index: ${claim.index}` };
      }
      if (claim.index >= extendedVectorLength) {
        return {
          ok: false,
          error:
            `claim index ${claim.index} out of range (extended vector length: ${extendedVectorLength})`,
        };
      }
      if (claim.index < ownOutputCount) {
        selfClaims.push(claim.index);
      } else {
        anchorClaims.push(claim.index);
      }
    }

    // 5. Compute claim mask (against anchor output space)
    const claimMask = this.computeClaimMask(
      anchorOutputCount,
      mergedSubtreeMask,
      anchorClaims,
      ownOutputCount,
      totalSubtreeOutputs,
    );

    if (!claimMask.ok) {
      return { ok: false, error: claimMask.error };
    }

    // 6. Compute output count
    const ownClaimCount = spec.claims.length;
    const outputCount = this.computeOutputCount(
      anchorOutputCount,
      subtreeAnchorClaims,
      totalSubtreeOutputs,
      ownOutputCount,
      ownClaimCount,
    );

    // 7. Derive weight vector
    const weight = this.deriveWeightVector(spec.declaredWeight, subtreeInfos);

    // 8. Validate throughput
    const throughputResult = this.validateThroughput(spec.claims, spec.outputs, ownOutputCount);
    if (!throughputResult.ok) {
      return { ok: false, error: throughputResult.error };
    }

    // 9. Build outputs array — user outputs + aggregation contract output (if aggregating)
    const allOutputs = [...spec.outputs];

    if (spec.aggregates.length > 0) {
      // Compute chainWeights (weight vector without own declaredWeight)
      const chainWeights = [...weight];
      chainWeights[0] -= spec.declaredWeight;

      // Encode aggregation data into a contract output
      const aggDataJson = JSON.stringify({
        claimMask: claimMask.mask.toJSON(),
        outputCount,
        aggregateOutputCounts,
        chainWeights,
        aggregateWeights,
      });

      allOutputs.push({
        verifier: { contract: this.provider.getAggregationContract(), params: new Uint8Array(0) },
        value: 0,
        detail: new TextEncoder().encode(aggDataJson),
      });
    }

    // 10. Build blueprint
    const blueprint: BlockBlueprint = {
      anchor: spec.anchor,
      aggregates: spec.aggregates,
      claims: spec.claims.map((c) => c.index),
      outputs: allOutputs,
      declaredWeight: spec.declaredWeight,
      refs: spec.refs,
    };

    return { ok: true, blueprint };
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
  ): { ok: true } | { ok: false; error: string } {
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
      return {
        ok: false,
        error:
          `self-claim value mismatch: claimed ${selfClaimTotal}, output ${selfClaimedOutputTotal}`,
      };
    }

    // Non-self claims should balance with non-self-claimed outputs
    if (claimTotal !== outputTotal) {
      return {
        ok: false,
        error: `throughput imbalance: inputs ${claimTotal}, outputs ${outputTotal}`,
      };
    }

    return { ok: true };
  }

  /**
   * Compute the claim mask against anchor output space.
   * Merges the subtree mask with own non-self claims mapped to anchor indices.
   */
  computeClaimMask(
    anchorOutputCount: number,
    mergedSubtreeMask: BitVector,
    ownAnchorClaimIndices: number[],
    ownOutputCount: number,
    totalSubtreeOutputs: number,
  ): { ok: true; mask: BitVector } | { ok: false; error: string } {
    const mask = mergedSubtreeMask.clone();

    // Map own non-self claims back to anchor output indices.
    // Own claims are against the extended vector:
    //   [own outputs (0..ownOutputCount-1), subtree outputs..., surviving anchor outputs...]
    // Non-self claims have index >= ownOutputCount.
    // Indices in [ownOutputCount, ownOutputCount + totalSubtreeOutputs) target subtree outputs.
    // Indices >= ownOutputCount + totalSubtreeOutputs target surviving anchor outputs.
    for (const claimIdx of ownAnchorClaimIndices) {
      const relIdx = claimIdx - ownOutputCount;

      if (relIdx < totalSubtreeOutputs) {
        // Claim on a subtree output — internal, doesn't affect anchor mask
        continue;
      }

      // Claim on a surviving anchor output
      const survivingIdx = relIdx - totalSubtreeOutputs;
      const anchorIdx = this.mapSurvivingToOriginal(
        survivingIdx,
        mergedSubtreeMask,
        anchorOutputCount,
      );

      if (anchorIdx === -1) {
        return {
          ok: false,
          error: `claim maps to invalid anchor output (surviving index ${survivingIdx})`,
        };
      }

      mask.set(anchorIdx, true);
    }

    return { ok: true, mask };
  }

  /**
   * Compute the total output count after full transformation.
   * outputCount = anchorOutputCount - subtreeAnchorClaims + totalSubtreeOutputs
   *             + ownOutputCount - ownClaimCount
   */
  computeOutputCount(
    anchorOutputCount: number,
    subtreeAnchorClaims: number,
    totalSubtreeOutputs: number,
    ownOutputCount: number,
    ownClaimCount: number,
  ): number {
    return (
      anchorOutputCount -
      subtreeAnchorClaims +
      totalSubtreeOutputs +
      ownOutputCount -
      ownClaimCount
    );
  }

  // -- Internals --------------------------------------------------

  /**
   * Map a surviving output index to its original anchor index,
   * given a claim mask that has removed some outputs.
   */
  private mapSurvivingToOriginal(
    survivingIdx: number,
    claimMask: BitVector,
    anchorOutputCount: number,
  ): number {
    let survived = 0;
    for (let i = 0; i < anchorOutputCount; i++) {
      if (!claimMask.get(i)) {
        if (survived === survivingIdx) return i;
        survived++;
      }
    }
    return -1;
  }
}
