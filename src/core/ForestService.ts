import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { AtomType, BLOCK_REF_TYPE } from './types.ts';

export interface AggregatorNodeBase {
  aggregatingNodes: this[];
}

// Split from AnchorNodeBase rather than folded into it as a union-typed `type`:
// only a union of object types narrows, and only a narrowed union lets the walk
// below drop refs without a cast.
export interface RefNodeBase {
  type: typeof BLOCK_REF_TYPE;
}

export interface AnchorNodeBase {
  type: AtomType.Block;
  anchor?: this | RefNodeBase;
}

export const BROKEN_ANCHOR_CHAIN = Symbol('PlacementModule.brokenAnchorChain');

export class ForestModule {
  // Returns a set of all nodes in the anchor chain of `node`, including `node` itself.
  anchorChain<NodeType extends AnchorNodeBase>(
    node: NodeType | RefNodeBase,
  ): NodeType[] | typeof BROKEN_ANCHOR_CHAIN {
    const path: NodeType[] = [];
    let cur: NodeType | RefNodeBase | undefined = node;
    do {
      if (cur.type === BLOCK_REF_TYPE) return BROKEN_ANCHOR_CHAIN;
      path.push(cur);
      cur = cur.anchor;
    } while (cur !== undefined);
    return path;
  }

  // Returns a set of all nodes in every aggregation chain of `node`, including `node` itself.
  aggregators<NodeType extends AggregatorNodeBase>(node: NodeType): Set<NodeType> {
    const stack = [node];
    for (let i = 0; i < stack.length; i++) {
      for (const agg of stack[i].aggregatingNodes) {
        stack.push(agg);
      }
    }
    return new Set(stack);
  }

  // Enumerates all aggregation chains from `node`, each one including `node` itself.
  // Note the chain arrays are only valid for the lifetime of the callback.
  *aggregationChains<NodeType extends AggregatorNodeBase>(
    node: NodeType,
    base: NodeType[] = [],
  ): Generator<NodeType[]> {
    base.push(node);

    yield base;
    for (const agg of node.aggregatingNodes) {
      yield* this.aggregationChains(agg, base);
    }

    assert(base.pop() === node);
  }
}

export class ForestService extends ForestModule {
  constructor(_: Context) {
    super();
  }
}
