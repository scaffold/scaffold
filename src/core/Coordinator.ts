// Protocol spec: docs/protocol/overview.md (module orchestration)

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore, createBlock } from './Block.ts';
import { ConflictService } from './ConflictService.ts';
import { ConsensusService } from './ConsensusService.ts';
import { SamplingService } from './SamplingService.ts';
import { GossipService } from './GossipService.ts';
import { BlockCreationService } from './BlockCreationService.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import { PushAction } from './GossipModule.ts';
import { Output } from './BlockCreationModule.ts';

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
  private readonly store: BlockStore;
  private readonly conflict: ConflictService;
  private readonly consensus: ConsensusService;
  private readonly sampling: SamplingService;
  private readonly gossip: GossipService;
  private readonly blockCreation: BlockCreationService;

  constructor(ctx: ProtocolContext) {
    this.store = ctx.get(BlockStore);
    this.conflict = ctx.get(ConflictService);
    this.consensus = ctx.get(ConsensusService);
    this.sampling = ctx.get(SamplingService);
    this.gossip = ctx.get(GossipService);
    this.blockCreation = ctx.get(BlockCreationService);
  }

  /**
   * Process a received block through all protocol modules.
   *
   * 1. Store the block
   * 2. Add to conflict module → discover conflicts
   * 3. Add to consensus module + register conflicts + set initial weight
   * 4. Gossip notification
   * 5. Diff canonical view for changes
   * 6. For newly canonical blocks, add to sampling
   */
  blockReceived(block: Block, fromPeer: string | null): BlockReceivedResult {
    // Snapshot canonical view before
    const canonicalBefore = new Set(this.consensus.getCanonicalView());

    // 1. Store the block
    this.store.put(block);

    // 2. Conflict detection
    const newConflicts = this.conflict.addBlock(block.hash);

    // 3. Consensus
    this.consensus.addBlock(block.hash);
    for (const [a, b] of newConflicts) {
      this.consensus.addConflict(a, b);
    }

    // Trust declared weight initially
    this.consensus.setVerifiedWeight(block.hash, block.weightVector);

    // 4. Gossip
    const pushActions = this.gossip.blockReceived(block.hash, fromPeer);

    // 5. Diff canonical view
    const canonicalAfter = this.consensus.getCanonicalView();
    const canonicalityChanges: { hash: Hash; canonical: boolean }[] = [];

    // Newly canonical
    for (const key of canonicalAfter) {
      if (!canonicalBefore.has(key)) {
        const hash = Hash.fromPrimitive(key);
        canonicalityChanges.push({ hash, canonical: true });
      }
    }
    // Newly non-canonical
    for (const key of canonicalBefore) {
      if (!canonicalAfter.has(key)) {
        const hash = Hash.fromPrimitive(key);
        canonicalityChanges.push({ hash, canonical: false });
      }
    }

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

      const buildResult = this.blockCreation.buildBlock({
        anchor: anchorHash,
        outputs: [output],
        claims: [],
        declaredWeight,
        aggregates: toAggregate,
      });
      if (!buildResult.ok) continue;

      const anchorBlock = this.store.get(anchorHash);
      if (!anchorBlock) continue;

      const block = createBlock(buildResult.blueprint, anchorBlock);
      const result = this.blockReceived(block, null);
      return { block, result };
    }

    return null;
  }
}
