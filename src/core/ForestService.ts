import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { AtomType, BLOCK_REF_TYPE } from './types.ts';

export interface AggregatorNodeBase {
  aggregatingNodes: this[];
}

export interface AnchorNodeBase {
  type: AtomType.Block | typeof BLOCK_REF_TYPE;
  anchor?: this;
}

export const BROKEN_ANCHOR_CHAIN = Symbol('PlacementModule.brokenAnchorChain');

export class ForestModule {
  // Returns a set of all nodes in the anchor chain of `node`, including `node` itself.
  anchorChain<NodeType extends AnchorNodeBase>(
    node: NodeType,
  ): (NodeType & { type: AtomType.Block })[] | typeof BROKEN_ANCHOR_CHAIN {
    const path: (NodeType & { type: AtomType.Block })[] = [];
    let cur: NodeType | undefined = node;
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
