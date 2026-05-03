// Protocol spec: docs/protocol/overview.md (module orchestration)

import { Hash } from '../util/Hash.ts';
import { Block, BlockStore, getBlockWeightVector } from './Block.ts';
import { ConsensusService } from './ConsensusService.ts';
import { SamplingService } from './SamplingService.ts';
import { BlockCreationService } from './BlockCreationService.ts';
import { OutputClaimService } from './OutputClaimService.ts';
import { BlockVerificationService } from './BlockVerificationService.ts';
import { ExecutionQueueService } from './ExecutionQueueService.ts';
import { ProtocolContext } from './ProtocolContext.ts';

/** Result of attempting verification of the next-priority tree. */
export type VerificationResult =
  | { verified: true; treeHash: Hash; terminalHash: Hash }
  | { verified: false; treeHash: Hash; reason: string }
  | { verified: false; treeHash: undefined; reason: string };
import { ScopedLogger } from './EventLog.ts';

/** Result of processing a block received event. */
export interface BlockReceivedResult {
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
  private readonly blockCreation: BlockCreationService;
  private readonly outputClaims: OutputClaimService;
  private readonly _log?: ScopedLogger;

  /** Collects canonicality changes from flushChanges(). */
  private readonly canonicalityChanges: { hash: Hash; canonical: boolean }[] = [];

  /** Collects conflicts discovered during blockReceived(). */
  private pendingConflicts: [Hash, Hash][] = [];

  constructor(ctx: ProtocolContext) {
    this._log = ctx.logger('coordinator');
    this.ctx = ctx;
    this.store = ctx.get(BlockStore);
    this.consensus = ctx.get(ConsensusService);
    this.sampling = ctx.get(SamplingService);
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

    // Wire sampling weight changes to consensus verified weights + queue reprioritization
    this.sampling.onWeightChange((hash) => {
      const block = this.store.get(hash);
      if (!block) return;
      const wf = this.sampling.getWeightFactor(hash);
      const declared = getBlockWeightVector(block);
      const verified = declared.map((w) => w * wf);
      this.consensus.setVerifiedWeight(hash, verified);

      this._log?.debug('weightUpdate', {
        hash: hash.toHex(),
        weightFactor: wf,
        verifiedWeight: verified,
      });

      const queue = this.ctx.maybeGet(ExecutionQueueService);
      if (queue) queue.reprioritize();
    });

    // Wire conflict info from consensus to sampling scheduling
    this.sampling.setConflictInfoSupplier((hash) => {
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
   * 4. Flush canonical view changes
   * 5. Update sampling module on canonicality changes
   */
  blockReceived(block: Block, fromPeer: string | null): BlockReceivedResult {
    const hash = block.hash.toHex();
    this._log?.info('blockReceived', {
      hash,
      fromPeer,
      anchor: block.anchor.toHex(),
      outputCount: block.outputs.length,
      claimCount: block.claimIndices.length,
      aggregateCount: block.aggregates.length,
    });

    // 1. Store the block
    this.store.put(block);

    // 2. Reset pending conflicts, then register output claims and trigger migration
    //    (conflicts fire via onConflict callback -> addConflict + collect)
    this.pendingConflicts.length = 0;
    this.outputClaims.addBlock(block.hash, block.claimIndices);
    this.outputClaims.onBlockLoaded(block.hash);

    // 3. Consensus -- start with declared weight (sampling will refine)
    this.consensus.addBlock(block.hash);
    const weightVector = getBlockWeightVector(block);
    this.consensus.setVerifiedWeight(block.hash, weightVector);

    // 4. Flush canonical view -- fires listener which populates canonicalityChanges
    this.canonicalityChanges.length = 0;
    this.consensus.flushChanges();
    const canonicalityChanges = [...this.canonicalityChanges];

    // 5. Update sampling module on canonicality changes
    for (const change of canonicalityChanges) {
      if (change.canonical) {
        this.sampling.addBlock(change.hash);
      } else {
        this.sampling.removeBlock(change.hash);
      }
    }

    const newConflicts = [...this.pendingConflicts];

    if (canonicalityChanges.length > 0 || newConflicts.length > 0) {
      this._log?.info('blockProcessed', {
        hash,
        canonicalityChanges: canonicalityChanges.map((c) => ({
          hash: c.hash.toHex(),
          canonical: c.canonical,
        })),
        newConflicts: newConflicts.map(([a, b]) => [a.toHex(), b.toHex()]),
      });
    }

    return { canonicalityChanges, newConflicts };
  }

  // -- Computation methods -------------------------------------------

  /**
   * Run verification on the next highest-priority tree: select via sampling,
   * descend to a terminal, and dispatch block-level verification. Resolves
   * with `{ verified: true | false, ... }` so strategies can react.
   *
   * Requires BlockVerificationService + SamplingService to be registered.
   */
  attemptVerification(): Promise<VerificationResult> | null {
    const verification = this.ctx.maybeGet(BlockVerificationService);
    const sampling = this.ctx.maybeGet(SamplingService);
    if (!verification || !sampling) return null;

    const treeHash = sampling.selectNext();
    if (!treeHash) {
      return Promise.resolve({
        verified: false as const,
        treeHash: undefined,
        reason: 'no trees to verify',
      });
    }

    const sampleResult = sampling.initSample(treeHash);
    if (!sampleResult.terminal) {
      return Promise.resolve({
        verified: false as const,
        treeHash,
        reason: sampleResult.reason,
      });
    }

    const terminalHash = sampleResult.blockHash;
    return verification.verify(terminalHash).then((result) => {
      sampling.recordVerification(terminalHash, result.accepted);
      if (result.accepted) {
        return { verified: true as const, treeHash, terminalHash };
      }
      return {
        verified: false as const,
        treeHash,
        reason: result.reason,
      };
    });
  }
}
