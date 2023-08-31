import {
  BlockFact,
  BlockSetFact,
  FactBase,
  FactSource,
  FactType,
} from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import BlockSetService, { NUM_BLOCKSET_LEVELS } from '~/sbl/BlockSetService.ts';
import Hash, { HashPrimitive, ZERO_HASH } from '~/sbl/util/Hash.ts';
import { Connection } from '~/sbl/ConnectionService.ts';
import { BlockInput } from '~/sbl/messages.ts';
import secp from '~/sbl/util/secp.ts';
import FactService from '~/sbl/FactService.ts';
import { assert } from '~/sbl/util/functional.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import BlockService from '~/sbl/BlockService.ts';

const MIN_VOTE_LEVEL = 0;

interface EmptyFrontier {
  type: undefined;
  hash: Hash;
  level: number;
  votes: bigint;
}

export default class FrontierService {
  private blocks: BlockFact[] = [];

  // This is the canonical (to our best knowledge) frontier.
  // Unmerged blocks or left?/right? merged blocks that ...
  private frontierSets: BlockSetFact[] = [];
  private frontierBlock?: BlockFact;

  private emptyFrontiers: EmptyFrontier[] = [];
  // private bestEmptyFrontier: EmptyFrontier;
  private emptyIdx = 0;

  private outputs = new Map<HashPrimitive, number>();

  // private updateEnqueued = false;

  constructor(private ctx: Context) {
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      this.emptyFrontiers.push({
        type: undefined,
        hash: ZERO_HASH,
        level: i,
        votes: 0n,
      });
    }
    // this.bestEmptyFrontier = this.emptyFrontiers[0];

    const cleanupInterval = ctx.config.timeProvider.setInterval(
      () => this.cleanup(),
      1000,
    );
    ctx.onDestruct(() =>
      ctx.config.timeProvider.clearInterval(cleanupInterval)
    );
  }

  private cleanup() {
    // if (this.blocks.length > 1000) {
    //   this.blocks = this.blocks.slice(500);
    // }
  }

  private selfValidate() {
    if (this.emptyIdx >= NUM_BLOCKSET_LEVELS) {
      throw new Error(`Frontier empty index is too high: ${this.emptyIdx}!`);
    }

    let prevLevel = this.emptyIdx;
    let prevHash = ZERO_HASH;
    for (const set of this.frontierSets) {
      if (set.level >= prevLevel) {
        throw new Error(`Frontier set level does not decrease!`);
      }
      prevLevel = set.level;

      if (!Hash.equals(set.frontier_vote, prevHash)) {
        throw new Error(`Frontier vote chain is not consistent!`);
      }
      prevHash = set.hash;
    }
  }

  public getBlockVote(inputs: BlockInput[]) {
    for (const input of inputs) {
      const key = this.ctx.get(BlockSetService).hashTreeIo(input);
      const level = this.outputs.get(key);
      if (level === undefined) {
        // throw new Error(`Inputs don't match with the frontier output`);
        // this.findOutput(input, key);
        console.error(
          `Inputs don't match with the frontier output; we really should throw an error here!`,
        );
      }
    }

    // TODO: Weight by level minus previous level; a frontier with level 10 and level 1 should almost always choose 10 since it covers 9 levels.
    if (this.frontierSets.length !== 0) {
      const idx = Math.floor(
        this.ctx.config.entropyProvider.randomNumber() *
          (this.frontierSets.length +
            (this.frontierBlock !== undefined ? 1 : 0)),
      );
      if (idx === this.frontierSets.length) {
        return this.frontierBlock!.hash;
      } else {
        return this.frontierSets[idx].hash;
      }
    } else {
      return this.frontierBlock !== undefined
        ? this.frontierBlock.hash
        : ZERO_HASH;
    }
  }

  public ingestBlock(block: BlockFact) {
    this.blocks.push(block);

    const keys: HashPrimitive[] = [];
    for (const input of block.inputs) {
      const key = this.ctx.get(BlockSetService).hashTreeIo(input);
      if (!this.outputs.has(key)) {
        this.findOutput(input, key);
        return;
      }
      keys.push(key);
    }

    for (const key of keys) {
      assert(this.outputs.delete(key));
    }

    const linkedBlocks = block.outputs.flatMap((_, idx) => {
      const key = this.ctx.get(BlockSetService)
        .hashTreeIo({ block_hash: block.hash, output_idx: idx });
      this.outputs.set(key, -1);
      return this.ctx.get(BlockService)
        .getClaims({ block_hash: block.hash, output_idx: idx });
    });

    if (this.frontierBlock === undefined) {
      this.frontierBlock = block;
    } else {
      this.ctx.get(BlockSetService).mergeBlocks(this.frontierBlock, block);
      this.frontierBlock = undefined;
    }

    linkedBlocks.forEach(({ block }) => this.ingestBlock(block));
  }

  public updateBlockVotes(fact: BlockFact | BlockSetFact, voteDelta: bigint) {
    const chain: BlockSetFact[] = [];

    while (true) {
      if (fact.type === FactType.BlockSet) {
        const idx = this.frontierSets.lastIndexOf(fact);
        if (idx !== -1) {
          const replaceAt = idx + 1;
          for (let i = 0; i < replaceAt; i++) {
            this.frontierSets[i].votes += voteDelta;
          }
          const prevCmp = this.frontierSets[replaceAt];
          if (
            fact.type === FactType.BlockSet &&
            (prevCmp === undefined || fact.votes > prevCmp.votes)
          ) {
            this.frontierSets.splice(replaceAt, Infinity, ...chain.reverse());
            chain.reduce((prevSet, curSet) => {
              if (prevSet.level === curSet.level) {
                this.ctx.get(BlockSetService).mergeSets(prevSet, curSet);
              }
              return curSet;
            }, fact);
          }
          break;
        }

        chain.push(fact);
      }

      fact.votes += voteDelta;

      for (const parent of fact.parentBlockSets) {
        if (Hash.equals(parent.left_child, fact.hash)) {
          this.updateBlockVotes(parent, voteDelta);
        }
      }

      if (Hash.equals(fact.frontier_vote, ZERO_HASH)) {
        const level = fact.type === FactType.BlockSet ? fact.level + 1 : 0;
        const frontier = this.emptyFrontiers[level];
        frontier.votes += voteDelta;
        const curFrontier = this.emptyFrontiers[this.emptyIdx];
        if (
          frontier.votes > curFrontier.votes ||
          (frontier.votes === curFrontier.votes && level > this.emptyIdx)
        ) {
          this.emptyIdx = level;
          this.frontierSets = chain.reverse();
        }
        break;
      }

      const next = this.ctx.get(FactService).get(fact.frontier_vote);
      if (next === undefined) {
        break;
      }

      if (next.type !== FactType.Block && next.type !== FactType.BlockSet) {
        throw new Error(`Frontier vote doesn't refer to a block or blockset!`);
      }

      fact = next;
    }
  }

  public ingestBlockSet(blockSet: BlockSetFact) {
    let totalVotes = this.ctx.get(BlockSetService).getVoters(blockSet.hash)
      .reduce((acc, cur) => acc + cur.votes, 0n);

    const leftChild = this.ctx.get(FactService).get(blockSet.left_child);
    if (leftChild !== undefined) {
      if (
        leftChild.type !== FactType.Block &&
        leftChild.type !== FactType.BlockSet
      ) {
        throw new Error(`Left child doesn't refer to a block or blockset!`);
      }

      totalVotes += leftChild.votes;
    }

    this.updateBlockVotes(blockSet, totalVotes);

    // if (
    //   blockSet.includedInputs.size === blockSet.input_count &&
    //   blockSet.includedOutputs.size === blockSet.output_count
    // ) {
    //   for (const key of blockSet.includedInputs) {
    //     if (!this.outputs.has(key)) {
    //       // this.findOutput(input, key);
    //       return;
    //     }
    //   }

    //   // TODO: Working here

    //   for (const key of blockSet.includedInputs) {
    //     assert(this.outputs.delete(key));
    //   }

    //   for (const key of blockSet.includedOutputs) {
    //     this.outputs.set(key, blockSet.level);
    //   }

    //   const prevSet = this.frontierSets[blockSet.level];
    //   if (prevSet === undefined) {
    //     this.frontierSets[blockSet.level] = blockSet;
    //   } else {
    //     this.ctx.get(BlockSetService).mergeSets(prevSet, blockSet);
    //     this.frontierSets[blockSet.level] = undefined;
    //   }
    // }
  }

  private findOutput(input: BlockInput, key: HashPrimitive) {
    const block = this.ctx.get(FactService).get(input.block_hash);
    if (block !== undefined) {
      if (block.type !== FactType.Block) {
        throw new Error(`Invalid type`);
      }
      const top = block.highestParentChain[block.highestParentChain.length - 1];
      if (this.frontierSets.includes(top)) {
        this.queryOutput(top, input);
        return;
      }
    }
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      const set = this.frontierSets[i];
      if (
        set !== undefined &&
        set.includedOutputs.size !== set.output_count &&
        !set.excludedOutputs.has(key)
      ) {
        this.queryOutput(set, input);
        return;
      }
    }

    // Input doesn't match with any output in the current frontier
  }

  private queryOutput(set: BlockSetFact, input: BlockInput) {
  }

  // public getBlockVote() {
  //   // this.updateFrontier();
  //   if (this.frontierSize <= MIN_VOTE_LEVEL) {
  //     return ZERO_HASH;
  //   }
  //   let idx = MIN_VOTE_LEVEL +
  //     Math.floor(this.ctx.config.entropyProvider.randomNumber() * (this.frontierSize - MIN_VOTE_LEVEL));
  //   while (true) {
  //     const fact = this.frontierSets[idx];
  //     if (fact !== undefined) {
  //       return fact.hash;
  //     }
  //     idx++;
  //   }
  // }

  public getChainIndex() {
    return this.frontierSets.reduce(
      (acc, cur) => acc + (1n << BigInt(cur.level)),
      0n,
    );
  }

  public sendTo(conn: Connection) {
    this.frontierSets.forEach((fact) => {
      if (fact.type === FactType.BlockSet) {
        conn.sendReliable(fact.data);
      }
    });
  }

  // public updateFrontierOld() {
  //   // this.updateEnqueued = false;

  //   const votes: Map<BlockSetFact | undefined, bigint>[] = [];
  //   for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
  //     const map = new Map();
  //     votes.push(map);

  //     const existing = this.frontierSets[i];
  //     if (existing !== undefined) {
  //       map.set(existing, 10n);
  //     }
  //   }

  //   this.blocks.forEach((block) => {
  //     const work = block.work;
  //     if (work === undefined) {
  //       return;
  //     }

  //     let front: BlockFact | BlockSetFact = block;
  //     while (true) {
  //       if (Hash.equals(front.frontier_vote, ZERO_HASH)) {
  //         const level = front.type === FactType.BlockSet ? front.level + 1 : 0;
  //         getOrCreate(votes[level], undefined, () => work, (acc) => acc + work);
  //         break;
  //       }
  //       const next = this.ctx.get(FactService).get(front.frontier_vote);
  //       if (next === undefined) {
  //         break;
  //       }
  //       if (next.type !== FactType.BlockSet) {
  //         throw new Error(`Frontier doesn't refer to a blockset!`);
  //       }
  //       getOrCreate(votes[next.level], next, () => work, (acc) => acc + work);
  //       front = next;
  //     }
  //   });

  //   let prevVote: BlockSetFact | undefined;
  //   let size = 0;
  //   for (let i = NUM_BLOCKSET_LEVELS; i-- > 0;) {
  //     let bestBlockSet: BlockSetFact | undefined;
  //     let bestScore = -1n;
  //     votes[i].forEach((score, blockSet) => {
  //       if (
  //         blockSet !== undefined
  //           ? Hash.equals(
  //             blockSet.frontier_vote,
  //             prevVote !== undefined ? prevVote.hash : ZERO_HASH,
  //           )
  //           : prevVote === undefined
  //       ) {
  //         if (score > bestScore) {
  //           bestBlockSet = blockSet;
  //           bestScore = score;
  //         }
  //       }
  //     });

  //     this.frontierSets[i] = bestBlockSet ?? this.emptyFrontiers[i];
  //     prevVote = bestBlockSet;

  //     if (bestBlockSet !== undefined && i > size) {
  //       size = i;
  //     }
  //   }

  //   this.frontierSize = size;

  //   // TODO: Make sure our frontier is consistent (each one votes for the next up)
  //   // I think this is the case but we should double-check
  // }
}
