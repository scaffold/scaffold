// Protocol spec: docs/protocol/overview.md (module orchestration)

import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore, getBlockWeightVector } from './Block.ts';
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
import { Output } from './BlockCreationModule.ts';
import { ExecutionResult } from './ExecutionModule.ts';
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
 * Event 1: blockReceived — processes a new block through all modules.
 * Event 2: canonicality changes — derived from diffing before/after canonical views.
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

  /** Collects conflicts discovered during blockReceived(). */
  private pendingConflicts: [Hash, Hash][] = [];

  constructor(ctx: ProtocolContext) {
    this.ctx = ctx;
    this.store = ctx.get(BlockStore);
    this.consensus = ctx.get(ConsensusService);
    this.sampling = ctx.get(SamplingService);
    this.gossip = ctx.get(GossipService);
    this.blockCreation = ctx.get(BlockCreationService);
    this.outputClaims = ctx.get(OutputClaimService);

    // Wire output claim conflicts to consensus + pending collection
    this.outputClaims.onConflict((a, b) => {
      this.consensus.addConflict(a, b);
      this.pendingConflicts.push([a, b]);
    });

    // Wire consensus change listener to collect canonicality changes
    this.consensus.onCanonicalityChange((hash, canonical) => {
      this.canonicalityChanges.push({ hash, canonical });
    });
  }

  /**
   * Process a received block through all protocol modules.
   *
   * 1. Store the block
   * 2. Reset pendingConflicts, register output claims and trigger migration
   *    (conflicts fire via callback -> addConflict + collect)
   * 3. Add to consensus module + set initial weight
   * 4. Gossip notification
   * 5. Flush canonical view changes
   * 6. For newly canonical blocks, add to sampling
   */
  blockReceived(block: Block, fromPeer: string | null): BlockReceivedResult {
    // 1. Store the block
    this.store.put(block);

    // 2. Reset pending conflicts, then register output claims and trigger migration
    //    (conflicts fire via onConflict callback -> addConflict + collect)
    this.pendingConflicts.length = 0;
    this.outputClaims.addBlock(block.hash, block.claims);
    this.outputClaims.onBlockLoaded(block.hash);

    // 3. Consensus
    this.consensus.addBlock(block.hash);

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

    const newConflicts = [...this.pendingConflicts];
    return { pushActions, canonicalityChanges, newConflicts };
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
