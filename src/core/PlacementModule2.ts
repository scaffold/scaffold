// Anchor selection. Protocol: wp 4.2 (reach and the anchor chain), 4.3 (trees),
// 7 (aggregation).
//
// A block's reach is its own tree plus the trees of every block on its anchor
// chain, and everything the block is responsible for has to land inside it.
// Two walks are enough to decide that:
//
//   anchor chain      block -> block.anchor -> ...        (terminates at genesis)
//   aggregation chain block -> canonicalAggregator -> ... (terminates at a tree root)
//
// The aggregation chain of P is exactly the set of blocks whose trees contain P,
// so "P is in K's reach" is the single test `anchorChain(K) meets aggChain(P)`.

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Context } from '../Context.ts';
import { assert, error, todo } from '../util/functional.ts';
import { ScopedLogger } from './EventLog.ts';
import { AtomType, Block, BLOCK_REF_TYPE, BlockRef } from './types.ts';

interface PlacementNode {
  hash: Hash;
  type: AtomType.Block | typeof BLOCK_REF_TYPE;

  anchor?: this;

  // These are other nodes referring to this block by hash
  anchoringNodes: this[];
  aggregatingNodes: this[];
}

export interface PlacementRequest<NodeType extends PlacementNode> {
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
  /** `anchor` reaches every include and no exclude. */
  | { ok: true; anchor: NodeType }
  /**
   * Nothing in the current view reaches everything the draft needs. `tips` are
   * the current tree roots of the include set; when there is more than one, an
   * aggregation merging them is what unblocks this draft (wp 7). Placement does
   * not trigger that aggregation -- it waits for one, locally or from a peer.
   */
  | { ok: false; tips: NodeType[] };

export abstract class PlacementModule<NodeType extends PlacementNode> {
  protected abstract logger(): ScopedLogger | undefined;

  place({ includes, aggregates, excludes }: PlacementRequest<NodeType>): PlacementResult<NodeType> {
    const log = this.logger();
    const chains = new Map<HashPrimitive, NodeType[]>();
    const ours = keysOf(aggregates);

    // Includes already inside the tree we are building need no coverage from
    // the anchor -- wp 4.2 accepts "included in B". What does need coverage is
    // each aggregate's own anchor, and where that anchor is also ours the
    // requirement passes further up its chain.
    const required: NodeType[] = [];
    for (const node of includes) {
      if (meets(ours, this.aggregationChain(node, chains))) continue;
      required.push(node);
    }
    for (const aggregate of aggregates) {
      required.push(this.anchorOutsideTree(aggregate, ours, chains));
    }
    assert(required.length > 0, 'placement: draft has no claims, refs or aggregates');

    const includeChains = required.map((node) => this.aggregationChain(node, chains));
    const excludeChains = excludes.map((node) => this.aggregationChain(node, chains));
    const tips = dedupe(includeChains.map((chain) => chain[chain.length - 1]));

    // Only blocks on an include chain can qualify: a covering anchor must have
    // some include's containing tree on its anchor chain, and those trees are
    // precisely the include chains' entries.
    const candidates = dedupe(includeChains.flat())
      .filter((node): node is Block => node.type === AtomType.Block);

    const reaches = new Map<HashPrimitive, Set<HashPrimitive>>();
    for (const candidate of candidates) {
      const reach = this.anchorChain(candidate);
      if (reach === undefined) {
        // A link we hold only by hash. We cannot prove coverage through it, and
        // more importantly cannot prove an exclude is absent, so drop it.
        log?.debug('anchor_chain_unresolved', { candidate: candidate.hash.toHex() });
        continue;
      }
      if (!includeChains.every((chain) => meets(reach, chain))) continue;
      if (excludeChains.some((chain) => meets(reach, chain))) {
        log?.debug('candidate_excluded', { candidate: candidate.hash.toHex() });
        continue;
      }
      reaches.set(candidate.hash.toPrimitive(), reach);
    }

    if (reaches.size === 0) {
      log?.debug('placement_stalled', {
        tips: tips.map((tip) => tip.hash.toHex()),
        candidates: candidates.length,
        excludes: excludeChains.length,
      });
      return { ok: false, tips };
    }

    // Several blocks can cover the same include set -- typically a block and an
    // aggregation that later swallowed it. Take the tightest: the one every
    // other qualifying block can still see. It is the freshest anchor covering
    // the draft, and it keeps the chain array short.
    const qualifying = candidates.filter((c) => reaches.has(c.hash.toPrimitive()));
    const anchor = qualifying.find((candidate) => {
      const chain = this.aggregationChain(candidate, chains);
      return qualifying.every((other) => meets(reaches.get(other.hash.toPrimitive())!, chain));
    });
    if (anchor === undefined) {
      // Every candidate covers the draft but none is visible from all the
      // others, so "tightest" is not defined. Expected to be unreachable; if it
      // fires, the reach ordering needs a tie-break rule rather than a guess.
      return error(
        `placement: qualifying anchors are unordered by reach ` +
          `(${qualifying.map((c) => c.hash.toHex().slice(0, 8)).join(', ')})`,
      );
    }
    return { ok: true, anchor };
  }

  /**
   * Walk `node`'s anchor chain to the first block outside the tree we are
   * building -- the block that must be in the new block's reach on that
   * aggregate's behalf (wp 4.2).
   */
  private anchorOutsideTree(
    node: NodeType,
    ours: Set<HashPrimitive>,
    chains: Map<HashPrimitive, NodeType[]>,
  ): NodeType {
    let cur = node;
    while (meets(ours, this.aggregationChain(cur, chains))) {
      const next = cur.type === AtomType.Block ? cur.anchor : undefined;
      if (next === undefined) {
        return error(`placement: aggregate ${cur.hash.toHex()} has no anchor outside the tree`);
      }
      cur = next;
    }
    return cur;
  }

  private aggregators(node: NodeType): Set<NodeType> {
    const aggregators = new Set<NodeType>();
    const stack = [node];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const agg of cur.aggregatingNodes) {
        if (!aggregators.has(agg)) {
          aggregators.add(agg);
          stack.push(agg);
        }
      }
    }
    return aggregators;
  }

  private anchorChain(node: NodeType): Set<NodeType> {
    const path = new Set<NodeType>();
    let cur: NodeType | undefined = node;
    do {
      path.add(cur);
      cur = cur.anchor;
    } while (cur !== undefined);
    return path;
  }
}

export class PlacementService extends PlacementModule<Block | BlockRef> {
  constructor(private ctx: Context) {
    super();
  }

  protected override logger(): ScopedLogger | undefined {
    return this.ctx.logger('placement');
  }
}

const keysOf = (nodes: PlacementNode[]): Set<HashPrimitive> =>
  new Set(nodes.map((node) => node.hash.toPrimitive()));

/** Does any node of `chain` appear in `keys`? */
const meets = (keys: Set<HashPrimitive>, chain: PlacementNode[]): boolean =>
  chain.some((node) => keys.has(node.hash.toPrimitive()));

const dedupe = (nodes: PlacementNode[]): PlacementNode[] => {
  const byHash = new Map<HashPrimitive, PlacementNode>();
  for (const node of nodes) byHash.set(node.hash.toPrimitive(), node);
  return [...byHash.values()];
};
