// TODO: Use BlockSets to simplify instead of a tree

interface Branch<Node> {
  node: Node; // TODO: Remove (although WeakSet will work even with this reference)

  // The sum total value of all child leaf values
  value: bigint;

  parentBranch?: Branch<Node>;
  upstreamBranch?: Branch<Node>;
  notUpstreamBranch?: Branch<Node>;
}

/*
A:1 -> B:2 -> C:4 -> D:8
{
  node: B,
  value: 15,
  upstreamBranch: {
    node: A,
    value: 1,
  },
  notUpstreamBranch: {
    node: D,
    value: 12,
    upstreamBranch: {
      node: C,
      value: 4,
    }
  }
}
*/

export default class GraphPropagator<Node extends object> {
  public getValue(branch: Branch<Node>) {
    let sum = branch.value;
    if (branch.notUpstreamBranch) {
      sum -= branch.notUpstreamBranch.value;
    }
    while (true) {
      if (branch.parentBranch === undefined) {
        break;
      }
      if (branch.parentBranch.upstreamBranch === branch) {
        //
        return;
      } else {
      }
    }
    return sum;
  }

  // TODO: Maybe just return the Branch object and store it in the Node?
  private branches = new WeakMap<Node, Branch<Node>>();

  constructor(
    private extractor: (node: Node) => {
      value: bigint;
      downstreamNodes: Node[];
      upstreamNodes: Node[];
    },
  ) {}

  public insert(node: Node) {
    const { value, downstreamNodes, upstreamNodes } = this.extractor(node);
    // Recursively, add to all downstream nodes.
    // However, if we can add to a node that represents ALL upstream nodes, we can stop.

    // The common ancestor of all downstream nodes

    const branch: Branch<Node> = { value, node };
    this.branches.set(node, branch);
    return branch;
  }

  public getBranch(node: Node) {
    return this.branches.get(node)!;
  }

  public addValue(branch: Branch<Node>, value: bigint) {
    do {
      branch.value += value;
      if (branch.parentBranch === undefined) {
        break;
      }
    } while (branch !== undefined);
  }

  // public addValue(branch: Branch, value: bigint) {
  //   branch.value += value;
  // }
}
