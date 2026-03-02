import { Hash, HashPrimitive } from './util/Hash.ts';
import { Block, BlockStore } from './Block.ts';
import { ConflictService } from './ConflictService.ts';
import { ConsensusService } from './ConsensusService.ts';
import { SamplingService } from './SamplingService.ts';
import { GossipService } from './GossipService.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import { PushAction } from './GossipModule.ts';

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

  constructor(ctx: ProtocolContext) {
    this.store = ctx.get(BlockStore);
    this.conflict = ctx.get(ConflictService);
    this.consensus = ctx.get(ConsensusService);
    this.sampling = ctx.get(SamplingService);
    this.gossip = ctx.get(GossipService);
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
}
