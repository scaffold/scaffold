// Protocol spec: docs/protocol/overview.md (module orchestration)

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore, getBlockWeightVector } from './Block.ts';
import { composeUnsignedBlockPacket } from './Packet.ts';
import { ConsensusService } from './ConsensusService.ts';
import { SamplingService } from './SamplingService.ts';
import { GossipService } from './GossipService.ts';
import { BlockCreationService } from './BlockCreationService.ts';
import { OutputClaimService } from './OutputClaimService.ts';
import { ExecutionService } from './ExecutionService.ts';
import { VerificationService } from './VerificationService.ts';
import { DisputeService } from './DisputeService.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import { PushAction } from './GossipModule.ts';
import { BlockBlueprint, Output } from './BlockCreationModule.ts';
import { VerificationResult } from './VerificationModule.ts';
import { ResolutionResult } from './DisputeModule.ts';

/** Result of processing a block received event. */
export interface BlockReceivedResult {
  pushActions: PushAction[];
  canonicalityChanges: { hash: Hash; canonical: boolean }[];
  newConflicts: [Hash, Hash][];
}

/**
 * Two-event orchestrator that coordinates all protocol modules.
 *
 * Event 1: blockReceived -- processes a new block through all modules.
 * Event 2: canonicality changes -- derived from diffing before/after canonical views.
 */
export class Coordinator {
  private readonly ctx: ProtocolContext;
  private readonly store: BlockStore;
  private readonly consensus: ConsensusService;
  private readonly sampling: SamplingService;
  private readonly gossip: GossipService;
  private readonly blockCreation: BlockCreationService;
  private readonly outputClaims: OutputClaimService;

  /** Collects canonicality changes from flushChanges(). */
  private readonly canonicalityChanges: { hash: Hash; canonical: boolean }[] = [];

  constructor(ctx: ProtocolContext) {
    this.ctx = ctx;
    this.store = ctx.get(BlockStore);
    this.consensus = ctx.get(ConsensusService);
    this.sampling = ctx.get(SamplingService);
    this.gossip = ctx.get(GossipService);
    this.blockCreation = ctx.get(BlockCreationService);
    this.outputClaims = ctx.get(OutputClaimService);

    // Wire consensus change listener to collect canonicality changes
    this.consensus.onCanonicalityChange((hash, canonical) => {
      this.canonicalityChanges.push({ hash, canonical });
    });
  }

  /**
   * Process a received block through all protocol modules.
   *
   * 1. Store the block
   * 2. Register output claims, trigger migration, detect conflicts
   * 3. Add to consensus module + register conflicts + set initial weight
   * 4. Gossip notification
   * 5. Flush canonical view changes
   * 6. For newly canonical blocks, add to sampling
   */
  blockReceived(block: Block, fromPeer: string | null): BlockReceivedResult {
    // 1. Store the block
    this.store.put(block);

    // 2. Output claim tracking + conflict detection
    const claimResult = this.outputClaims.addBlock(block.hash, block.claims);
    const loadResult = this.outputClaims.onBlockLoaded(block.hash);
    const newConflicts: [Hash, Hash][] = [
      ...claimResult.conflicts,
      ...loadResult.conflicts,
    ];

    // 3. Consensus
    this.consensus.addBlock(block.hash);
    for (const [a, b] of newConflicts) {
      this.consensus.addConflict(a, b);
    }

    // Trust declared weight initially -- reconstruct weight vector from block
    const weightVector = getBlockWeightVector(block);
    this.consensus.setVerifiedWeight(block.hash, weightVector);

    // 4. Gossip
    const pushActions = this.gossip.blockReceived(block.hash, fromPeer);

    // 5. Flush canonical view -- fires listener which populates canonicalityChanges
    this.canonicalityChanges.length = 0;
    this.consensus.flushChanges();
    const canonicalityChanges = [...this.canonicalityChanges];

    // 6. For newly canonical blocks, add to sampling
    for (const change of canonicalityChanges) {
      if (change.canonical) {
        this.sampling.addTree(change.hash);
      }
    }

    return { pushActions, canonicalityChanges, newConflicts };
  }

  /**
   * Find canonical, non-aggregated leaf blocks that share an anchor, build an
   * aggregation block, and submit it. Returns the new block or null if no
   * aggregation opportunity exists.
   *
   * @param output  Output to include in the aggregation block.
   * @param declaredWeight  Declared weight (default 1).
   * @param maxChildren  Maximum blocks to aggregate at once (default 3).
   */
  attemptAggregation(
    output: Output,
    declaredWeight = 1,
    maxChildren = 3,
  ): { block: Block; result: BlockReceivedResult } | null {
    const canonical = this.consensus.getCanonicalView();

    // Group canonical leaf blocks by anchor
    const byAnchor = new Map<HashPrimitive, Hash[]>();
    for (const key of canonical) {
      const block = this.store.get(Hash.fromPrimitive(key));
      if (!block || Hash.equals(block.anchor, ZERO_HASH)) continue;
      // Skip already-aggregated blocks
      if (this.store.isAggregated(block.hash)) continue;
      // Skip blocks that are themselves aggregations
      if (block.aggregates.length > 0) continue;

      const anchorKey = block.anchor.toPrimitive();
      let arr = byAnchor.get(anchorKey);
      if (!arr) {
        arr = [];
        byAnchor.set(anchorKey, arr);
      }
      arr.push(block.hash);
    }

    // Find a group with 2+ blocks
    for (const [anchorKey, hashes] of byAnchor) {
      if (hashes.length < 2) continue;

      const toAggregate = hashes.slice(0, maxChildren);
      const anchorHash = Hash.fromPrimitive(anchorKey);

      let blueprint: BlockBlueprint;
      try {
        blueprint = this.blockCreation.buildBlock({
          anchor: anchorHash,
          outputs: [output],
          claims: [],
          declaredWeight,
          aggregates: toAggregate,
          refs: [],
        });
      } catch (e) {
        console.debug('buildBlock failed during aggregation:', (e as Error).message);
        continue;
      }

      const block = composeUnsignedBlockPacket(blueprint).block;
      const result = this.blockReceived(block, null);
      return { block, result };
    }

    return null;
  }

  // -- Computation methods -------------------------------------------

  /**
   * Run verification on the next highest-priority tree.
   * Requires ExecutionService and VerificationService to be registered.
   */
  attemptVerification(): VerificationResult | null {
    const verification = this.ctx.maybeGet(VerificationService);
    if (!verification) return null;
    return verification.verifyNext();
  }

  /**
   * Resolve a dispute for a target block.
   * Requires DisputeService to be registered.
   */
  resolveDispute(targetHash: Hash): ResolutionResult | null {
    const dispute = this.ctx.maybeGet(DisputeService);
    if (!dispute) return null;
    return dispute.resolve(targetHash);
  }
}
