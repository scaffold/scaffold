// Protocol spec: docs/protocol/overview.md (module orchestration)

import { Hash } from '../util/Hash.ts';
import { Block, BlockStore, getBlockWeightVector } from './Block.ts';
import { ConsensusService } from './ConsensusService.ts';
import { ProbeService } from './ProbeService.ts';
import { GossipService } from './GossipService.ts';
import { BlockCreationService } from './BlockCreationService.ts';
import { OutputClaimService } from './OutputClaimService.ts';
import { VerificationService } from './VerificationService.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import { PushAction } from './GossipModule.ts';
import { VerificationResult } from './VerificationModule.ts';

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
  private readonly probe: ProbeService;
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
    this.probe = ctx.get(ProbeService);
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

    // Wire probe weight changes to consensus verified weights
    this.probe.onWeightChange((hash) => {
      const block = this.store.get(hash);
      if (!block) return;
      const wf = this.probe.getWeightFactor(hash);
      const declared = getBlockWeightVector(block);
      this.consensus.setVerifiedWeight(hash, declared.map((w) => w * wf));
    });

    // Wire conflict info from consensus to probe scheduling
    this.probe.setConflictInfoSupplier((hash) => {
      const conflicts = this.consensus.getConflicts(hash);
      if (conflicts.size === 0) return undefined;

      const myWeight = this.consensus.getEffectiveWeight(hash);
      let closestGap = Infinity;
      let closestRivalWeight = 0;

      for (const rivalKey of conflicts) {
        const rivalHash = Hash.fromPrimitive(rivalKey);
        const rivalWeight = this.consensus.getEffectiveWeight(rivalHash);
        const gap = Math.abs(myWeight - rivalWeight);
        if (gap < closestGap) {
          closestGap = gap;
          closestRivalWeight = rivalWeight;
        }
      }

      return {
        weightGap: closestGap,
        contestedWeight: myWeight + closestRivalWeight,
      };
    });
  }

  /**
   * Process a received block through all protocol modules.
   *
   * 1. Store the block
   * 2. Reset pendingConflicts, register output claims and trigger migration
   *    (conflicts fire via callback -> addConflict + collect)
   * 3. Add to consensus module + set initial weight (unverified = 0)
   * 4. Gossip notification
   * 5. Flush canonical view changes
   * 6. Update probe module on canonicality changes
   */
  blockReceived(block: Block, fromPeer: string | null): BlockReceivedResult {
    // 1. Store the block
    this.store.put(block);

    // 2. Reset pending conflicts, then register output claims and trigger migration
    //    (conflicts fire via onConflict callback -> addConflict + collect)
    this.pendingConflicts.length = 0;
    this.outputClaims.addBlock(block.hash, block.claims);
    this.outputClaims.onBlockLoaded(block.hash);

    // 3. Consensus -- start with declared weight (probing will refine)
    this.consensus.addBlock(block.hash);
    const weightVector = getBlockWeightVector(block);
    this.consensus.setVerifiedWeight(block.hash, weightVector);

    // 4. Gossip
    const pushActions = this.gossip.blockReceived(block.hash, fromPeer);

    // 5. Flush canonical view -- fires listener which populates canonicalityChanges
    this.canonicalityChanges.length = 0;
    this.consensus.flushChanges();
    const canonicalityChanges = [...this.canonicalityChanges];

    // 6. Update probe module on canonicality changes
    for (const change of canonicalityChanges) {
      if (change.canonical) {
        this.probe.addBlock(change.hash);
      } else {
        this.probe.removeBlock(change.hash);
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
}
