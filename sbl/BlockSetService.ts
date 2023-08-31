import Context from '~/sbl/Context.ts';
import Hash, { HASH_SIZE, HashPrimitive, ZERO_HASH } from '~/sbl/util/Hash.ts';
import {
  BlockInput,
  BlockSet,
  BlockSetTreeIo,
  BlockSetTreeNode,
  FrontierMessage,
  Verifier,
} from '~/sbl/messages.ts';
import {
  BlockFact,
  BlockSetFact,
  BlockSetTreeNodeFact,
  Fact,
  FactBase,
  FactSource,
  FactType,
} from '~/sbl/FactMeta.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import FactService from '~/sbl/FactService.ts';
import NodeService from '~/sbl/NodeService.ts';
import HashRequestService from '~/sbl/HashRequestService.ts';
import { assert } from '~/sbl/util/functional.ts';
import FrontierService from '~/sbl/FrontierService.ts';

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

// Merging blocks:
// The left block NEEDS to have all input blocks so we know which verifiers

export interface BlockSetMeta {
  parentBlockSets: BlockSetFact[];
  myParentBlockSet?: BlockSetFact;
  active: boolean;

  includedInputs: Set<HashPrimitive>;
  includedOutputs: Set<HashPrimitive>;
  excludedInputs: Set<HashPrimitive>;
  excludedOutputs: Set<HashPrimitive>;

  // voters: (BlockFact | BlockSetFact)[];
  votes: bigint;
}

type TreeNode = null | [TreeNode, TreeNode] | HashPrimitive;

const tryCatchLog = (cb: () => void) => {
  try {
    cb();
  } catch (err) {
    console.error(err);
  }
};

export default class BlockSetService {
  // private nextBlock?: BlockFact;
  // private sets: BlockSetFact[][] = [];
  // private mySets: (BlockSetFact | undefined)[] = [];

  private parents = new Map<HashPrimitive, BlockSetFact[]>();

  private voters = new Map<HashPrimitive, (BlockFact | BlockSetFact)[]>();

  constructor(private ctx: Context) {
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      // this.sets.push([]);
      // this.mySets.push(undefined);
    }
  }

  public getParents(hash: Hash) {
    return getOrCreate(this.parents, hash.toPrimitive(), () => []);
  }

  public getVoters(hash: Hash, level?: number) {
    if (Hash.equals(hash, ZERO_HASH)) {
      if (level === undefined) {
        throw new Error(`Must specify a level for the zero hash!`);
      }
      hash = Hash.fromLiteral32(level);
    }
    return getOrCreate(this.voters, hash.toPrimitive(), () => []);
  }

  // public getMySets() {
  //   return this.mySets;
  // }

  public createFact(
    base: FactBase,
    mutator?: (fact: BlockSetFact) => void,
  ): BlockSetFact {
    const blockSet = BlockSet.decode(base.message);

    const meta: BlockSetMeta = {
      parentBlockSets: this.getParents(base.hash),
      active: true,

      includedInputs: new Set(),
      includedOutputs: new Set(),
      excludedInputs: new Set(),
      excludedOutputs: new Set(),

      // voters: this.getVoters(base.hash),
      votes: 0n,
    };

    const fact: BlockSetFact = Object.assign(
      base,
      blockSet,
      meta,
      { type: FactType.BlockSet as const },
    );

    this.addParent(blockSet.left_child, fact);
    this.addParent(blockSet.right_child, fact);

    const chain = [];
    chain[fact.level] = fact;
    this.updateBlockChains(blockSet.left_child, chain);
    this.updateBlockChains(blockSet.right_child, chain);

    this.getVoters(blockSet.frontier_vote, blockSet.level).push(fact);

    // const level = this.sets[fact.level];
    // if (level === undefined) {
    //   throw new Error(`Invalid level ${fact.level}`);
    // }
    // level.push(fact);

    if (mutator !== undefined) {
      mutator(fact);
    }

    this.ctx.get(FrontierService).ingestBlockSet(fact);

    return fact;
  }

  public createTreeNodeFact(base: FactBase): BlockSetTreeNodeFact {
    return Object.assign(
      base,
      BlockSetTreeNode.decode(base.message).node,
      { type: FactType.BlockSetTreeNode as const },
    );
  }

  // public ingestBlock(block: BlockFact) {
  //   const scores = new Map<BlockFact, number>();
  //   if (this.nextBlock !== undefined) {
  //     // Prefer to join with the unjoined block
  //     scores.set(this.nextBlock, 0.5);
  //   }
  //   block.inputs.forEach((input) => {
  //     const inputFact = this.ctx.get(FactService).get(input.block_hash);
  //     if (inputFact !== undefined) {
  //       if (inputFact.type !== FactType.Block) {
  //         throw new Error(
  //           `Internal error! Invalid fact type ${inputFact.type}`,
  //         );
  //       }
  //       if (inputFact.timestamp >= block.timestamp) {
  //         throw new Error(`Blocks are not ordered!`);
  //       }
  //       getOrCreate(
  //         scores,
  //         inputFact,
  //         () => this.getUnbindScore(inputFact) + 1,
  //         (n) => n + 1,
  //       );
  //     }
  //   });
  //   block.outputClaims.forEach((claims) =>
  //     claims.forEach((claim) => {
  //       if (claim.timestamp <= block.timestamp) {
  //         throw new Error(`Blocks are not ordered!`);
  //       }
  //       getOrCreate(
  //         scores,
  //         claim,
  //         () => this.getUnbindScore(claim) + 1,
  //         (n) => n + 1,
  //       );
  //     })
  //   );

  //   let bestScore = -Infinity;
  //   let bestSibling: BlockFact | undefined;
  //   scores.forEach((score, block) => {
  //     if (score > bestScore) {
  //       bestScore = score;
  //       bestSibling = block;
  //     }
  //   });

  //   if (bestSibling === undefined) {
  //     this.nextBlock = block;
  //     return;
  //   }

  //   if (bestSibling.myParentBlockSet === undefined) {
  //     if (bestSibling !== this.nextBlock) {
  //       throw new Error(`Unexpected internal state`);
  //     }
  //     const { left, right } = this.orderBlocks(block, bestSibling);
  //     tryCatchLog(() => this.mergeBlocks(left, right));
  //     this.nextBlock = undefined;
  //   } else {
  //     if (bestSibling === this.nextBlock) {
  //       throw new Error(`Unexpected internal state`);
  //     }

  //     const orphanedBlock = this.getOtherChild(
  //       bestSibling.myParentBlockSet,
  //       bestSibling.hash,
  //       FactType.Block,
  //     );
  //     this.forgetBlockSet(bestSibling.myParentBlockSet);

  //     const { left, right } = this.orderBlocks(block, bestSibling);
  //     tryCatchLog(() => this.mergeBlocks(left, right));

  //     if (this.nextBlock !== undefined) {
  //       const { left, right } = this.orderBlocks(this.nextBlock, orphanedBlock);
  //       tryCatchLog(() => this.mergeBlocks(left, right));
  //       this.nextBlock = undefined;
  //     } else {
  //       this.nextBlock = orphanedBlock;
  //     }
  //   }
  // }

  // private ingestBlockSet(blockSet: BlockSetFact) {
  //   const scores = new Map<BlockSetFact, number>();
  //   const myCandidate = this.mySets[blockSet.level];
  //   if (myCandidate !== undefined) {
  //     // Prefer to join with my candidate block
  //     scores.set(myCandidate, 0.5);
  //   }
  //   this.sets[blockSet.level].forEach((candidate) => {
  //     if (candidate !== blockSet) {
  //       getOrCreate(
  //         scores,
  //         candidate,
  //         () => this.getUnbindScore(candidate) + 1,
  //         (n) => n + 1,
  //       );
  //     }
  //   });

  //   let bestScore = -Infinity;
  //   let bestSibling: BlockSetFact | undefined;
  //   scores.forEach((score, blockSet) => {
  //     if (score > bestScore) {
  //       bestScore = score;
  //       bestSibling = blockSet;
  //     }
  //   });

  //   if (bestSibling === undefined) {
  //     this.mySets[blockSet.level] = blockSet;
  //     return;
  //   }

  //   if (bestSibling.myParentBlockSet === undefined) {
  //     const { left, right } = this.orderBlocks(blockSet, bestSibling);
  //     tryCatchLog(() => this.mergeSets(blockSet.level, left, right));
  //     if (bestSibling === myCandidate) {
  //       this.mySets[blockSet.level] = undefined;
  //     }
  //   } else {
  //     if (bestSibling === myCandidate) {
  //       throw new Error(`Unexpected internal state`);
  //     }

  //     const orphanedBlock = this.getOtherChild(
  //       bestSibling.myParentBlockSet,
  //       bestSibling.hash,
  //       FactType.BlockSet,
  //     );
  //     this.forgetBlockSet(bestSibling.myParentBlockSet);

  //     const { left, right } = this.orderBlocks(blockSet, bestSibling);
  //     tryCatchLog(() => this.mergeSets(blockSet.level, left, right));

  //     if (myCandidate !== undefined) {
  //       const { left, right } = this.orderBlocks(myCandidate, orphanedBlock);
  //       tryCatchLog(() => this.mergeSets(blockSet.level, left, right));
  //       this.mySets[blockSet.level] = undefined;
  //     } else {
  //       this.mySets[blockSet.level] = orphanedBlock;
  //     }
  //   }
  // }

  // private orderBlocks<Type extends { timestamp: bigint }>(
  //   left: Type,
  //   right: Type,
  // ) {
  //   if (left.timestamp === right.timestamp) {
  //     throw new Error(`Timestamps are the same!`);
  //   }
  //   if (left.timestamp > right.timestamp) {
  //     const t = left;
  //     left = right;
  //     right = t;
  //   }

  //   return { left, right };
  // }

  // private getUnbindScore(block: BlockFact | BlockSetFact) {
  //   if (block.myParentBlockSet === undefined) {
  //     // The block isn't bound, so no unbind penalty
  //     return 0;
  //   } else if (this.nextBlock === undefined) {
  //     // There's no block to bind with, so just a simple unbind penalty
  //     return -block.myParentBlockSet.score;
  //   } else {
  //     // Unbind and re-bind the sibling with this.nextBlock
  //     // const sibling = this.getOtherChild(block.myParentBlockSet, block.hash);
  //     // return this.getBlockPairScore(sibling, this.nextBlock) -
  //     //   block.myParentBlockSet.score;
  //     return -block.myParentBlockSet.score;
  //   }
  // }

  // private getOtherChild<Type extends FactType>(
  //   set: BlockSetFact,
  //   hash: Hash,
  //   type: Type,
  // ) {
  //   if (
  //     !Hash.equals(set.left_child, hash) &&
  //     !Hash.equals(set.right_child, hash)
  //   ) {
  //     throw new Error(`Hash isn't in the set!`);
  //   }
  //   return this.ctx.get(FactService).getAs(
  //     Hash.equals(set.left_child, hash) ? set.right_child : set.left_child,
  //     type,
  //   );
  // }

  // private getBlockPairScore(a: BlockFact, b: BlockFact) {
  //   const { left, right } = this.orderBlocks(a, b);

  //   let score = 0;
  //   right.inputs.forEach((input) => {
  //     if (Hash.equals(input.block_hash, left.hash)) {
  //       score++;
  //     }
  //   });
  //   return score;
  // }

  private addParent(childHash: Hash, parent: BlockSetFact) {
    this.getParents(childHash).push(parent);

    const child = this.ctx.get(FactService).get(childHash);
    if (child !== undefined) {
      child.fromNodes.slice(0, 4).forEach((node) =>
        this.ctx.get(FactService).sendTo(parent, node)
      );
    }
  }

  private updateBlockChains(hash: Hash, chain: BlockSetFact[]) {
    const fact = this.ctx.get(FactService).get(hash);
    if (fact !== undefined) {
      if (fact.type === FactType.Block) {
        if (chain.length > fact.highestParentChain.length) {
          fact.highestParentChain = [...chain];
        }
      } else if (fact.type === FactType.BlockSet) {
        chain[fact.level] = fact;
        this.updateBlockChains(fact.left_child, chain);
        this.updateBlockChains(fact.right_child, chain);
      } else {
        throw new Error(`Invalid type ${fact.type}!`);
      }
    }
  }

  // private forgetBlockSet(blockSet: BlockSetFact) {
  //   if (!blockSet.active) {
  //     throw new Error(`Cannot deactivate an inactive blockset`);
  //   }
  //   blockSet.active = false;

  //   const left = this.ctx.get(FactService).get(blockSet.left_child);
  //   const right = this.ctx.get(FactService).get(blockSet.right_child);
  //   if (left === undefined || !('myParentBlockSet' in left)) {
  //     throw new Error(`Invalid left child fact ${left}`);
  //   }
  //   if (right === undefined || !('myParentBlockSet' in right)) {
  //     throw new Error(`Invalid right child fact ${right}`);
  //   }
  //   if (
  //     left.myParentBlockSet !== blockSet || right.myParentBlockSet !== blockSet
  //   ) {
  //     throw new Error(`BlockSet children aren't linked correctly!`);
  //   }

  //   left.myParentBlockSet = undefined;
  //   right.myParentBlockSet = undefined;
  // }

  private requestAll(root: Hash, signedFact: Fact): boolean {
    const node = this.ctx.get(FactService).get(root);
    if (node === undefined) {
      this.ctx.get(HashRequestService).requestHash(root, signedFact);
      return false;
    }

    if (node.type !== FactType.BlockSetTreeNode) {
      throw new Error(`Tree hash is to an invalid type ${node.type}`);
    }

    if ('BlockSetTreeBranch' in node) {
      const { left_child, right_child } = node.BlockSetTreeBranch;
      const hasLeft = left_child === null ||
        this.requestAll(left_child.Hash, signedFact);
      const hasRight = right_child === null ||
        this.requestAll(right_child.Hash, signedFact);
      return hasLeft && hasRight;
    } else {
      return true;
    }
  }

  // private maybeMergeBlocks(left: BlockFact, right: BlockFact) {
  //   if (left.hash.toPrimitive() === right.hash.toPrimitive()) {
  //     throw new Error(`Cannot merge the same block! ${left.hash.toHex()}`);
  //   }

  //   const lrOverlap = right.inputs
  //     .filter(({ block_hash }) => Hash.equals(block_hash, left.hash)).length;
  //   const rlOverlap = left.inputs
  //     .filter(({ block_hash }) => Hash.equals(block_hash, right.hash)).length;

  //   if (lrOverlap >= rlOverlap) {
  //     tryCatchLog(() => this.mergeBlocks(left, right));
  //   } else {
  //     tryCatchLog(() => this.mergeBlocks(right, left));
  //   }
  // }

  public mergeBlocks(left: BlockFact, right: BlockFact) {
    if (left.claimedWork === undefined || right.claimedWork === undefined) {
      throw new Error(`Blocks do not have claimedWork set!`);
    }
    if (left.timestamp >= right.timestamp) {
      throw new Error(`Blocks are not ordered!`);
    }

    const inputs = new Map<HashPrimitive, BlockSetTreeIo[]>();
    const outputs = new Map<HashPrimitive, BlockSetTreeIo[]>();

    let inputCount = 0;
    let outputCount = 0;

    left.inputs.forEach(({ block_hash, output_idx }) => {
      getOrCreate(inputs, block_hash.toPrimitive(), () => [])
        .push({ block_hash, output_idx, amount: -1n });
      inputCount++;
    });
    right.outputs.forEach(({ verifier, amount }, idx) => {
      getOrCreate(
        outputs,
        Hash.digest(Verifier.encode(verifier)).toPrimitive(),
        () => [],
      ).push({ block_hash: right.hash, output_idx: idx, amount });
      outputCount++;
    });

    const skipIdxs = new Set<number>();
    right.inputs.forEach(({ block_hash, output_idx }) => {
      if (Hash.equals(block_hash, left.hash)) {
        skipIdxs.add(output_idx);
      } else {
        getOrCreate(inputs, block_hash.toPrimitive(), () => [])
          .push({ block_hash, output_idx, amount: -1n });
        inputCount++;
      }
    });

    left.outputs.forEach(({ verifier, amount }, idx) => {
      if (!skipIdxs.has(idx)) {
        getOrCreate(
          outputs,
          Hash.digest(Verifier.encode(verifier)).toPrimitive(),
          () => [],
        ).push({ block_hash: left.hash, output_idx: idx, amount });
        outputCount++;
      }
    });

    const set: BlockSet = {
      left_child: left.hash,
      right_child: right.hash,

      input_tree_root: this.hashTree(this.createTree(inputs), inputs)!.Hash,
      output_tree_root: this.hashTree(this.createTree(outputs), outputs)!.Hash,

      frontier_vote: this.getVote(left, right),

      input_count: inputCount,
      output_count: outputCount,

      level: 0,
      score: skipIdxs.size,
      claimed_work: left.claimedWork + right.claimedWork,
      timestamp: right.timestamp + 1n,
    };

    this.createBlockSet(set, left, right, inputs, outputs);
  }

  // private maybeMergeSets(
  //   level: number,
  //   left: BlockSetFact,
  //   right: BlockSetFact,
  // ) {
  //   if (left.hash.toPrimitive() === right.hash.toPrimitive()) {
  //     throw new Error(`Cannot merge the same blockset! ${left.hash.toHex()}`);
  //   }

  //   if (
  //     left.includedInputs.size !== left.input_count ||
  //     left.includedOutputs.size !== left.output_count ||
  //     right.includedInputs.size !== right.input_count ||
  //     right.includedOutputs.size !== right.output_count
  //   ) {
  //     console.info(
  //       `Skipping merge because we don't have all inputs or outputs`,
  //       left,
  //       right,
  //     );
  //     return;
  //   }

  //   for (const el of left.includedInputs) {
  //     if (right.includedInputs.has(el)) {
  //       return;
  //     }
  //   }
  //   for (const el of left.includedOutputs) {
  //     if (right.includedOutputs.has(el)) {
  //       return;
  //     }
  //   }

  //   let lrOverlap = 0;
  //   for (const el of left.includedOutputs) {
  //     if (right.includedInputs.has(el)) {
  //       lrOverlap++;
  //     }
  //   }

  //   let rlOverlap = 0;
  //   for (const el of right.includedOutputs) {
  //     if (left.includedInputs.has(el)) {
  //       rlOverlap++;
  //     }
  //   }

  //   if (lrOverlap >= rlOverlap) {
  //     tryCatchLog(() => this.mergeSets(level, left, right));
  //   } else {
  //     tryCatchLog(() => this.mergeSets(level, right, left));
  //   }
  // }

  public mergeSets(left: BlockSetFact, right: BlockSetFact) {
    if (left.level !== right.level) {
      throw new Error(`Cannot merge blocksets at different levels!`);
    }

    const inputs = new Map<HashPrimitive, BlockSetTreeIo[]>();
    const outputs = new Map<HashPrimitive, BlockSetTreeIo[]>();

    let inputCount = 0;
    let outputCount = 0;

    this.walkTree(left.input_tree_root, (blockHash, ios) => {
      inputs.set(blockHash.toPrimitive(), ios);
      inputCount += ios.length;
    });
    if (inputCount !== left.input_count) {
      throw new Error(
        `Unexpected input count! ${inputCount} !== ${left.input_count}`,
      );
    }

    this.walkTree(right.output_tree_root, (verifierHash, ios) => {
      outputs.set(verifierHash.toPrimitive(), ios);
      outputCount += ios.length;
    });
    if (outputCount !== right.output_count) {
      throw new Error(
        `Unexpected output count! ${outputCount} !== ${right.output_count}`,
      );
    }

    this.walkTree(
      right.input_tree_root,
      (blockHash, ios) => {
        ios = ios.filter((io) =>
          !left.includedOutputs.has(this.hashTreeIo(io))
        );
        if (ios.length > 0) {
          getOrCreate(
            inputs,
            blockHash.toPrimitive(),
            () => ios,
            (arr) => arr.concat(ios),
          );
          inputCount += ios.length;
        }
      },
    );
    this.walkTree(
      left.output_tree_root,
      (verifierHash, ios) => {
        ios = ios.filter((io) =>
          !right.includedInputs.has(this.hashTreeIo(io))
        );
        if (ios.length > 0) {
          getOrCreate(
            outputs,
            verifierHash.toPrimitive(),
            () => ios,
            (arr) => arr.concat(ios),
          );
          outputCount += ios.length;
        }
      },
    );

    const score = left.input_count + right.input_count - inputCount;
    if (score !== left.output_count + right.output_count - outputCount) {
      throw new Error(`Input score and output score do not match!`);
    }

    const set: BlockSet = {
      left_child: left.hash,
      right_child: right.hash,

      input_tree_root: this.hashTree(this.createTree(inputs), inputs)!.Hash,
      output_tree_root: this.hashTree(this.createTree(outputs), outputs)!.Hash,

      frontier_vote: this.getVote(left, right),

      input_count: inputCount,
      output_count: outputCount,

      level: left.level + 1,
      score,
      claimed_work: left.claimed_work + right.claimed_work,
      timestamp:
        (left.timestamp > right.timestamp ? left.timestamp : right.timestamp) +
        1n,
    };

    this.createBlockSet(set, left, right, inputs, outputs);
  }

  private createBlockSet(
    set: BlockSet,
    left: BlockFact | BlockSetFact,
    right: BlockFact | BlockSetFact,
    inputs: Map<HashPrimitive, BlockSetTreeIo[]>,
    outputs: Map<HashPrimitive, BlockSetTreeIo[]>,
  ) {
    const data = this.ctx.get(FactService)
      .compose(set, BlockSet, FactType.BlockSet);
    this.ctx.get(FactService).ingest(
      data,
      FactSource.Local,
      this.ctx.get(NodeService).getSelfNode(),
      (fact) => {
        if (fact.type !== FactType.BlockSet) {
          throw new Error(`Internal error! Invalid fact type ${fact.type}`);
        }

        left.myParentBlockSet = fact;
        right.myParentBlockSet = fact;

        inputs.forEach((ios) =>
          ios.forEach((io) => fact.includedInputs.add(this.hashTreeIo(io)))
        );
        outputs.forEach((ios) =>
          ios.forEach((io) => fact.includedOutputs.add(this.hashTreeIo(io)))
        );

        // fact.votes
      },
    );
  }

  private walkTree(root: Hash, cb: (key: Hash, ios: BlockSetTreeIo[]) => void) {
    const node = this.ctx.get(FactService)
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

    const data = this.ctx.get(FactService)
      .compose({ node }, BlockSetTreeNode, FactType.BlockSetTreeNode);
    const fact = this.ctx.get(FactService)
      .ingest(data, FactSource.Local, this.ctx.get(NodeService).getSelfNode());
    if (fact.type !== FactType.BlockSetTreeNode) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }

    return { Hash: fact.hash };
  }

  public hashTreeIo(io: BlockInput) {
    // Don't compare amount because input amounts will be -1
    console.log(
      io.block_hash.toHex(),
      io.output_idx,
      Hash.digestParts(io.block_hash, io.output_idx).toHex(),
    );
    return Hash.digestParts(io.block_hash, io.output_idx).toPrimitive();
  }

  private getVote(
    left: BlockFact | BlockSetFact,
    right: BlockFact | BlockSetFact,
  ) {
    if (Hash.equals(left.hash, right.frontier_vote)) {
      return left.frontier_vote;
    } else if (Hash.equals(left.frontier_vote, right.frontier_vote)) {
      return left.frontier_vote;
    } else {
      let leftVote = this.ctx.get(FactService)
        .getAs(left.frontier_vote, FactType.BlockSet);
      let rightVote = this.ctx.get(FactService)
        .getAs(right.frontier_vote, FactType.BlockSet);

      if (leftVote.level < rightVote.level) {
        while (true) {
          const nextVote = this.ctx.get(FactService)
            .getAs(leftVote.frontier_vote, FactType.BlockSet);
        }
      } else if (leftVote.level > rightVote.level) {
      } else {
        throw new Error(`Votes are different; unmergeable!`);
      }
    }

    return ZERO_HASH;
  }
}
