import Context from '~/sbl/Context.ts';
import Hash, { HASH_SIZE, HashPrimitive } from '~/sbl/util/Hash.ts';
import {
  BlockSet,
  BlockSetTreeIo,
  BlockSetTreeLeaf,
  BlockSetTreeNode,
} from '~/sbl/messages.ts';
import { SIGNATURE_LENGTH } from '~/sbl/PacketCoder.ts';
import {
  BlockSetFact,
  FactBase,
  FactSource,
  FactType,
} from '~/sbl/FactMeta.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import IngestionService from '~/sbl/IngestionService.ts';
import NodeService from '~/sbl/NodeService.ts';

/*
BlockSets specify their position?
  No this would just make them always reject
BlockSets specify their input (left) BlockSet hash?
  This means that each level is a chain and will get slow for deep levels
Or the top of the left blockstack hash?

The only thing they maybe can specify is a further-back and further-up block
*/

export const NUM_BLOCKSET_LEVELS = 64;

// Index/sort tree by verifier hash? This allows efficient queries

export interface BlockSetMeta {
  hasAllInputs: boolean;
  hasAllOutputs: boolean;

  provedInputs: Set<HashPrimitive>;
  provedOutputs: Set<HashPrimitive>;

  hashInversions: Map<HashPrimitive, BlockSetTreeNode['node']>;
}

type TreeNode = null | [TreeNode, TreeNode] | HashPrimitive;

export default class BlockSetService {
  private sets: BlockSetFact[][] = [];

  constructor(private ctx: Context) {
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      this.sets.push([]);
    }
  }

  public createFact(base: FactBase) {
    const blockSet = BlockSet.decode(base.data.subarray(SIGNATURE_LENGTH + 1));

    const meta: BlockSetMeta = {
      hasAllInputs: false,
      hasAllOutputs: false,

      provedInputs: new Set(),
      provedOutputs: new Set(),

      hashInversions: new Map(),
    };

    const fact: BlockSetFact = Object.assign(base, blockSet, meta, {
      type: FactType.BlockSet as const,
    });

    const level = this.sets[blockSet.level];
    if (level === undefined) {
      throw new Error(`Invalid level ${blockSet.level}`);
    }

    level.forEach((candidate) => {
      this.maybeMerge(blockSet.level, candidate, fact);
    });

    return fact;
  }

  private maybeMerge(level: number, left: BlockSetFact, right: BlockSetFact) {
    if (
      !left.hasAllInputs || !left.hasAllOutputs || !right.hasAllInputs ||
      !right.hasAllOutputs
    ) {
      throw new Error(`Cannot merge blocksets without all inputs and outputs`);
    }

    for (const el of left.provedInputs) {
      if (right.provedInputs.has(el)) {
        return;
      }
    }
    for (const el of left.provedOutputs) {
      if (right.provedOutputs.has(el)) {
        return;
      }
    }

    let lrOverlap = 0;
    for (const el of left.provedOutputs) {
      if (right.provedInputs.has(el)) {
        lrOverlap++;
      }
    }

    let rlOverlap = 0;
    for (const el of right.provedOutputs) {
      if (left.provedInputs.has(el)) {
        rlOverlap++;
      }
    }

    if (lrOverlap > 0 && lrOverlap >= rlOverlap) {
      // Merge left to right
      this.merge(level, left, right);
    } else if (rlOverlap > 0) {
      // Merge right to left
      this.merge(level, right, left);
    }
  }

  private merge(level: number, left: BlockSetFact, right: BlockSetFact) {
    const inputs = new Map<HashPrimitive, BlockSetTreeIo[]>();
    const outputs = new Map<HashPrimitive, BlockSetTreeIo[]>();

    this.walkTree(
      left.input_tree_root,
      left.hashInversions,
      (verifierHash, ios) => inputs.set(verifierHash.toPrimitive(), ios),
    );
    this.walkTree(
      right.output_tree_root,
      right.hashInversions,
      (verifierHash, ios) => outputs.set(verifierHash.toPrimitive(), ios),
    );
    this.walkTree(
      right.input_tree_root,
      right.hashInversions,
      (verifierHash, ios) => {
        ios = ios.filter((io) => !left.provedOutputs.has(this.hashTreeIo(io)));
        if (ios.length > 0) {
          getOrCreate(
            inputs,
            verifierHash.toPrimitive(),
            () => ios,
            (arr) => arr.concat(ios),
          );
        }
      },
    );
    this.walkTree(
      left.output_tree_root,
      left.hashInversions,
      (verifierHash, ios) => {
        ios = ios.filter((io) => !right.provedInputs.has(this.hashTreeIo(io)));
        if (ios.length > 0) {
          getOrCreate(
            outputs,
            verifierHash.toPrimitive(),
            () => ios,
            (arr) => arr.concat(ios),
          );
        }
      },
    );

    const hashInversions = new Map<HashPrimitive, BlockSetTreeNode['node']>();
    const set: BlockSet = {
      left_child: left.hash,
      right_child: right.hash,

      input_tree_root:
        this.hashTree(this.createTree(inputs), inputs, hashInversions)!.Hash,
      output_tree_root:
        this.hashTree(this.createTree(outputs), outputs, hashInversions)!.Hash,

      level: level + 1,
      loss: 0n,
      timestamp: BigInt(this.ctx.config.timeProvider.now()),
    };

    const fact = this.ctx.get(IngestionService).ingest(
      BlockSet.encode(set),
      FactSource.Local,
      this.ctx.get(NodeService).getSelfNode(),
    );
    if (fact.type !== FactType.BlockSet) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }

    fact.hashInversions = hashInversions;
  }

  private walkTree(
    root: Hash,
    hashInversions: Map<HashPrimitive, BlockSetTreeNode['node']>,
    cb: (verifierHash: Hash, ios: BlockSetTreeIo[]) => void,
  ) {
    const node = hashInversions.get(root.toPrimitive());
    if (node === undefined) {
      throw new Error(`Hash ${root.toHex()} is not in the inversion table!`);
    }

    if ('BlockSetTreeBranch' in node) {
      const { left_child, right_child } = node.BlockSetTreeBranch;
      if (left_child !== null) {
        this.walkTree(left_child.Hash, hashInversions, cb);
      }
      if (right_child !== null) {
        this.walkTree(right_child.Hash, hashInversions, cb);
      }
    }
    if ('BlockSetTreeLeaf' in node) {
      const { verifier_hash, ios } = node.BlockSetTreeLeaf;
      cb(verifier_hash, ios);
    }
  }

  private createTree<Leaf>(leaves: Map<HashPrimitive, Leaf>) {
    const root: TreeNode = [null, null];
    leaves.forEach((_leaf, key) => {
      const hash = Hash.fromPrimitive(key);
      let t: [TreeNode, TreeNode] = root;
      for (let i = 0; i < HASH_SIZE * 8; i++) {
        const b = hash.bit(i);
        const u = t[b];
        if (u === null) {
          t[b] = key;
          break;
        } else if (Array.isArray(u)) {
          t = u;
        } else {
          const v: TreeNode = [null, null];
          v[Hash.fromPrimitive(u).bit(i + 1)] = u;
          t[b] = v;
          t = v;
        }
      }
    });
    return root;
  }

  private hashTree(
    tree: TreeNode,
    leaves: Map<HashPrimitive, BlockSetTreeIo[]>,
    hashInversions: Map<HashPrimitive, BlockSetTreeNode['node']>,
  ): null | { Hash: Hash } {
    let node: BlockSetTreeNode['node'];
    if (tree === null) {
      return null;
    } else if (Array.isArray(tree)) {
      node = {
        BlockSetTreeBranch: {
          left_child: this.hashTree(tree[0], leaves, hashInversions),
          right_child: this.hashTree(tree[0], leaves, hashInversions),
        },
      };
    } else {
      const val = leaves.get(tree);
      if (val === undefined) {
        throw new Error(`Invalid hash ${Hash.fromPrimitive(tree).toHex()}`);
      }
      node = {
        BlockSetTreeLeaf: { verifier_hash: Hash.fromPrimitive(tree), ios: val },
      };
    }
    const hash = Hash.digest(BlockSetTreeNode.encode({ node }));
    hashInversions.set(hash.toPrimitive(), node);
    return { Hash: hash };
  }

  private hashTreeIo(io: BlockSetTreeIo) {
    return Hash.digest(BlockSetTreeIo.encode(io)).toPrimitive();
  }
}
