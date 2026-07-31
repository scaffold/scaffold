import { AtomType, Block, BLOCK_REF_TYPE, BlockRef } from './types.ts';
import { setsIntersect } from '../util/set.ts';
import { assert, error } from '../util/functional.ts';
import { BROKEN_ANCHOR_CHAIN } from './ForestService.ts';

export interface PlacementNode {
  anchor?: this;
  aggregatingNodes: this[];
}

export interface PlacementRequest<NodeType extends PlacementNode> {
  /**
   * The genesis block.
   */
  genesis: NodeType;

  /**
   * Producers of the draft's claims and refs. Every one must end up in the
   * anchor's reach (wp 4.2).
   */
  includes: NodeType[];

  /**
   * Blocks the draft rolls up. These land inside the new block's own tree, so
   * they impose no coverage requirement of their own -- but their anchors do,
   * and the anchor we pick must stay outside the tree we are building.
   */
  aggregates: NodeType[];

  /**
   * Blocks that must stay out of the anchor's reach. A rival already claiming
   * an output we intend to claim would order ahead of us (wp 4.4), making our
   * claim the disqualified one (wp 5.3).
   */
  excludes: NodeType[];
}

export type PlacementResult<NodeType extends PlacementNode> =
  | { ok: true; anchorChain: (NodeType & { type: AtomType.Block })[] }
  | { ok: false; tips: NodeType[] };

export abstract class PlacementModule<NodeType extends PlacementNode> {
  protected abstract anchorChain(
    node: NodeType,
  ): (NodeType & { type: AtomType.Block })[] | typeof BROKEN_ANCHOR_CHAIN;
  protected abstract aggregators(node: NodeType): Set<NodeType>;

  // Note this method assumes that the excluded blocks are not present in the aggregates
  // Failure of this precondition will result in an error
  place(req: PlacementRequest<NodeType>): PlacementResult<NodeType> {
    const aggregates = new Set(req.aggregates);
    const includeChains = [
      ...req.includes,
      ...req.aggregates.map((x) => x.anchor ?? error('Broken anchor')),
    ]
      .map((x) => this.aggregators(x))
      .filter((x) => !setsIntersect(aggregates, x));
    const excludeChains = req.excludes.map((x) => this.aggregators(x));

    if (excludeChains.some((x) => setsIntersect(aggregates, x))) {
      // This isn't merely a stalled build, it's a failing precondition
      throw new Error('Trying to aggregate an excluded block');
    }

    const candidates = new Set(includeChains.flatMap((x) => [...x]));
    // In the case where there's no include chains, there will be no candidates.
    // However in this case any block should be a valid anchor.
    // We add the genesis block so later, we can return a block downstream of it on the canonical frontier.
    candidates.add(req.genesis);

    const anchorChains: (NodeType & { type: AtomType.Block })[][] = [];
    for (const candidate of candidates) {
      const anchorChain = this.anchorChain(candidate);
      if (anchorChain === BROKEN_ANCHOR_CHAIN) continue;

      const chainBlocks = new Set(anchorChain);
      if (
        includeChains.every((x) => setsIntersect(chainBlocks, x)) &&
        excludeChains.every((x) => !setsIntersect(chainBlocks, x))
      ) {
        anchorChains.push(anchorChain);
      }
    }

    if (anchorChains.length === 0) {
      const tips = includeChains.flatMap((x) =>
        [...x].filter((x) => x.aggregatingNodes.length === 0)
      );
      return { ok: false, tips };
    }

    // TODO: Select the best anchor based on:
    // 1. size
    // 2. canonicality, since even losing aggregates are returned from this.aggregators
    // We may also want to consider blocks anchoring to one of these blocks.
    const anchorChain = anchorChains[0];

    return { ok: true, anchorChain };
  }
}
