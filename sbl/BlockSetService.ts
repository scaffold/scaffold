import Context from '~/sbl/Context.ts';
import Hash, { HASH_SIZE, HashPrimitive } from '~/sbl/util/Hash.ts';
import {
  BlockSet,
  BlockSetTreeIo,
  BlockSetTreeNode,
  Verifier,
} from '~/sbl/messages.ts';
import {
  BlockFact,
  BlockSetFact,
  BlockSetTreeNodeFact,
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
const DROP_BLOCKSET_AFTER = 4;

// Index/sort tree by verifier hash? This allows efficient queries

// Merging blocks:
// The left block NEEDS to have all input blocks so we know which verifiers

export interface BlockSetMeta {
  hasAllInputs: boolean;
  hasAllOutputs: boolean;

  provedInputs: Set<HashPrimitive>;
  provedOutputs: Set<HashPrimitive>;
}

type TreeNode = null | [TreeNode, TreeNode] | HashPrimitive;

export default class BlockSetService {
  private blocks: BlockFact[] = [];
  private sets: BlockSetFact[][] = [];

  constructor(private ctx: Context) {
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      this.sets.push([]);
    }
  }

  public ingestBlock(block: BlockFact) {
    this.blocks.forEach((candidate) => {
      this.maybeMergeBlocks(candidate, block);
    });

    this.blocks.push(block);
  }

  public createFact(base: FactBase): BlockSetFact {
    const blockSet = BlockSet.decode(base.message);

    const meta: BlockSetMeta = {
      hasAllInputs: false,
      hasAllOutputs: false,

      provedInputs: new Set(),
      provedOutputs: new Set(),
    };

    const fact: BlockSetFact = Object.assign(
      base,
      blockSet,
      meta,
      { type: FactType.BlockSet as const },
    );

    const level = this.sets[blockSet.level];
    if (level === undefined) {
      throw new Error(`Invalid level ${blockSet.level}`);
    }

    // if (blockSet.level >= DROP_BLOCKSET_AFTER) {
    //   let descendants = [fact];
    //   for (let i = 0; i < DROP_BLOCKSET_AFTER; i++) {
    //     descendants = descendants.flatMap((d) => [
    //       this.ctx.get(IngestionService)
    //         .getAs(d.left_child, FactType.BlockSet),
    //       this.ctx.get(IngestionService)
    //         .getAs(d.right_child, FactType.BlockSet),
    //     ]);
    //   }
    // }

    level.forEach((candidate) => {
      this.maybeMergeSets(blockSet.level, candidate, fact);
    });

    level.push(fact);

    return fact;
  }

  public createTreeNodeFact(base: FactBase): BlockSetTreeNodeFact {
    return Object.assign(
      base,
      BlockSetTreeNode.decode(base.message).node,
      { type: FactType.BlockSetTreeNode as const },
    );
  }

  private maybeMergeBlocks(left: BlockFact, right: BlockFact) {
    if (left.hash.toPrimitive() === right.hash.toPrimitive()) {
      throw new Error(`Cannot merge the same block! ${left.hash.toHex()}`);
    }

    const lrOverlap = right.inputs
      .filter(({ block_hash }) => Hash.equals(block_hash, left.hash)).length;
    const rlOverlap = left.inputs
      .filter(({ block_hash }) => Hash.equals(block_hash, right.hash)).length;

    if (lrOverlap > 0 && lrOverlap >= rlOverlap) {
      // Merge left to right
      this.mergeBlocks(left, right);
    } else if (rlOverlap > 0) {
      // Merge right to left
      this.mergeBlocks(right, left);
    }
  }

  private mergeBlocks(left: BlockFact, right: BlockFact) {
    const inputs = new Map<HashPrimitive, BlockSetTreeIo[]>();
    const outputs = new Map<HashPrimitive, BlockSetTreeIo[]>();

    left.inputs.forEach(({ block_hash, output_idx }) =>
      getOrCreate(inputs, block_hash.toPrimitive(), () => [])
        .push({ block_hash, output_idx, amount: -1n })
    );
    right.outputs.forEach(({ verifier, amount }, idx) =>
      getOrCreate(
        outputs,
        Hash.digest(Verifier.encode(verifier)).toPrimitive(),
        () => [],
      ).push({ block_hash: right.hash, output_idx: idx, amount })
    );

    const skipIdxs = new Set<number>();
    right.inputs.forEach(({ block_hash, output_idx }) => {
      if (Hash.equals(block_hash, left.hash)) {
        skipIdxs.add(output_idx);
      } else {
        getOrCreate(inputs, block_hash.toPrimitive(), () => [])
          .push({ block_hash, output_idx, amount: -1n });
      }
    });

    left.outputs.forEach(({ verifier, amount }, idx) => {
      if (!skipIdxs.has(idx)) {
        getOrCreate(
          outputs,
          Hash.digest(Verifier.encode(verifier)).toPrimitive(),
          () => [],
        ).push({ block_hash: right.hash, output_idx: idx, amount });
      }
    });

    const set: BlockSet = {
      left_child: left.hash,
      right_child: right.hash,

      input_tree_root: this.hashTree(this.createTree(inputs), inputs)!.Hash,
      output_tree_root: this.hashTree(this.createTree(outputs), outputs)!.Hash,

      level: 0,
      loss: 0n,
      timestamp: BigInt(this.ctx.config.timeProvider.now()),
    };

    const data = this.ctx.get(IngestionService)
      .compose(set, BlockSet, FactType.BlockSet);
    const fact = this.ctx.get(IngestionService)
      .ingest(data, FactSource.Local, this.ctx.get(NodeService).getSelfNode());
    if (fact.type !== FactType.BlockSet) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }
  }

  private maybeMergeSets(
    level: number,
    left: BlockSetFact,
    right: BlockSetFact,
  ) {
    if (
      !left.hasAllInputs || !left.hasAllOutputs || !right.hasAllInputs ||
      !right.hasAllOutputs
    ) {
      // TODO: Working here
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
      this.mergeSets(level, left, right);
    } else if (rlOverlap > 0) {
      // Merge right to left
      this.mergeSets(level, right, left);
    }
  }

  private mergeSets(level: number, left: BlockSetFact, right: BlockSetFact) {
    const inputs = new Map<HashPrimitive, BlockSetTreeIo[]>();
    const outputs = new Map<HashPrimitive, BlockSetTreeIo[]>();

    this.walkTree(
      left.input_tree_root,
      (blockHash, ios) => inputs.set(blockHash.toPrimitive(), ios),
    );
    this.walkTree(
      right.output_tree_root,
      (verifierHash, ios) => outputs.set(verifierHash.toPrimitive(), ios),
    );
    this.walkTree(
      right.input_tree_root,
      (blockHash, ios) => {
        ios = ios.filter((io) => !left.provedOutputs.has(this.hashTreeIo(io)));
        if (ios.length > 0) {
          getOrCreate(
            inputs,
            blockHash.toPrimitive(),
            () => ios,
            (arr) => arr.concat(ios),
          );
        }
      },
    );
    this.walkTree(
      left.output_tree_root,
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

    const set: BlockSet = {
      left_child: left.hash,
      right_child: right.hash,

      input_tree_root: this.hashTree(this.createTree(inputs), inputs)!.Hash,
      output_tree_root: this.hashTree(this.createTree(outputs), outputs)!.Hash,

      level: level + 1,
      loss: 0n,
      timestamp: BigInt(this.ctx.config.timeProvider.now()),
    };

    const data = this.ctx.get(IngestionService)
      .compose(set, BlockSet, FactType.BlockSet);
    const fact = this.ctx.get(IngestionService)
      .ingest(data, FactSource.Local, this.ctx.get(NodeService).getSelfNode());
    if (fact.type !== FactType.BlockSet) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }
  }

  private walkTree(root: Hash, cb: (key: Hash, ios: BlockSetTreeIo[]) => void) {
    const node = this.ctx.get(IngestionService)
      .getAs(root, FactType.BlockSetTreeNode);

    if ('BlockSetTreeBranch' in node) {
      const { left_child, right_child } = node.BlockSetTreeBranch;
      if (left_child !== null) {
        this.walkTree(left_child.Hash, cb);
      }
      if (right_child !== null) {
        this.walkTree(right_child.Hash, cb);
      }
    }
    if ('BlockSetTreeLeaf' in node) {
      const { key, ios } = node.BlockSetTreeLeaf;
      cb(key, ios);
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
  ): null | { Hash: Hash } {
    let node: BlockSetTreeNode['node'];
    if (tree === null) {
      return null;
    } else if (Array.isArray(tree)) {
      node = {
        BlockSetTreeBranch: {
          left_child: this.hashTree(tree[0], leaves),
          right_child: this.hashTree(tree[1], leaves),
        },
      };
    } else {
      const val = leaves.get(tree);
      if (val === undefined) {
        throw new Error(`Invalid hash ${Hash.fromPrimitive(tree).toHex()}`);
      }
      node = {
        BlockSetTreeLeaf: { key: Hash.fromPrimitive(tree), ios: val },
      };
    }

    const data = this.ctx.get(IngestionService)
      .compose({ node }, BlockSetTreeNode, FactType.BlockSetTreeNode);
    const fact = this.ctx.get(IngestionService)
      .ingest(data, FactSource.Local, this.ctx.get(NodeService).getSelfNode());
    if (fact.type !== FactType.BlockSetTreeNode) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }

    return { Hash: fact.hash };
  }

  private hashTreeIo(io: BlockSetTreeIo) {
    return Hash.digestParts(io.block_hash, io.output_idx).toPrimitive();
  }
}
