import {
  BlockFact,
  BlockSetFact,
  FactBase,
  FactSource,
  FactType,
  FrontierFact,
} from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import BlockSetService, { NUM_BLOCKSET_LEVELS } from '~/sbl/BlockSetService.ts';
import Hash, { HashPrimitive, ZERO_HASH } from '~/sbl/util/Hash.ts';
import { Connection } from '~/sbl/ConnectionService.ts';
import { BlockInput, FrontierMessage } from '~/sbl/messages.ts';
import secp from '~/sbl/util/secp.ts';
import FactService from '~/sbl/FactService.ts';
import { assert } from '~/sbl/util/functional.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import BlockService from '~/sbl/BlockService.ts';

const MIN_VOTE_LEVEL = 0;

export interface FrontierMeta {}

export default class FrontierService {
  private blocks: BlockFact[] = [];

  // This is the canonical (to our best knowledge) frontier.
  private frontierSize = 0;
  // Unmerged blocks or left?/right? merged blocks that
  private frontierSets: (BlockSetFact | undefined)[] = [];
  private frontierBlock?: BlockFact;

  private outputs = new Map<HashPrimitive, number>();

  private updateEnqueued = false;

  constructor(private ctx: Context) {
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      this.frontierSets.push(undefined);
    }

    const cleanupInterval = ctx.config.timeProvider.setInterval(
      () => this.cleanup(),
      1000,
    );
    ctx.onDestruct(() =>
      ctx.config.timeProvider.clearInterval(cleanupInterval)
    );
  }

  private cleanup() {
    if (this.blocks.length > 1000) {
      this.blocks = this.blocks.slice(500);
    }
  }

  public getBlockVote(inputs: BlockInput[]) {
    let minLevel = NUM_BLOCKSET_LEVELS;
    for (const input of inputs) {
      const key = Hash.digestParts(input.block_hash, input.output_idx)
        .toPrimitive();
      const level = this.outputs.get(key);
      if (level === undefined) {
        throw new Error(`Inputs don't match with the frontier output`);
        // this.findOutput(input, key);
        // return ZERO_HASH;
      }
      if (level < minLevel) {
        minLevel = level;
      }
    }

    if (minLevel <= MIN_VOTE_LEVEL) {
      return ZERO_HASH;
    }
    let idx = MIN_VOTE_LEVEL +
      Math.floor(Math.random() * (minLevel - MIN_VOTE_LEVEL));
    while (true) {
      const fact = this.frontierSets[idx];
      if (fact !== undefined) {
        return fact.hash;
      }
      idx++;
    }
  }

  public ingestBlock(block: BlockFact) {
    this.blocks.push(block);

    const keys: HashPrimitive[] = [];
    for (const input of block.inputs) {
      const key = Hash.digestParts(input.block_hash, input.output_idx)
        .toPrimitive();
      const level = this.outputs.get(key);
      if (level === undefined) {
        this.findOutput(input, key);
        return;
      }
      keys.push(key);
    }

    for (const key of keys) {
      assert(this.outputs.delete(key));
    }

    const linkedBlocks = block.outputs.flatMap((_, idx) => {
      const key = Hash.digestParts(block.hash, idx).toPrimitive();
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
  //     Math.floor(Math.random() * (this.frontierSize - MIN_VOTE_LEVEL));
  //   while (true) {
  //     const fact = this.frontierSets[idx];
  //     if (fact !== undefined) {
  //       return fact.hash;
  //     }
  //     idx++;
  //   }
  // }

  public getChainIndex() {
    let index = 0n;
    for (let i = 0; i < this.frontierSize; i++) {
      if (this.frontierSets[i] !== undefined) {
        index |= 1n << BigInt(i);
      }
    }
    return index;
  }

  public sendTo(conn: Connection) {
    this.frontierSets.forEach((fact) => {
      if (fact !== undefined) {
        conn.sendReliable(fact.data);
      }
    });
  }

  public createFact(base: FactBase): FrontierFact {
    throw new Error(`Should not be used`);

    // const frontier = FrontierMessage.decode(base.message);

    // if (
    //   base.signature === undefined ||
    //   !secp.verify(base.signature, base.hash.toBytes(), frontier.public_key)
    // ) {
    //   throw new Error(`Invalid frontier signature!`);
    // }

    // const meta: FrontierMeta = {};

    // const fact: FrontierFact = Object.assign(
    //   base,
    //   frontier,
    //   meta,
    //   { type: FactType.Frontier as const },
    // );

    // return fact;
  }

  // private enqueueFrontierUpdate() {
  //   if (!this.updateEnqueued) {
  //     this.ctx.config.timeProvider.setTimeout(() => this.updateFrontier(), 0);
  //     this.updateEnqueued = true;
  //   }
  // }

  public updateFrontier() {
    this.updateEnqueued = false;

    const mySets = this.ctx.get(BlockSetService).getMySets();

    const votes: Map<BlockSetFact | undefined, bigint>[] = [];
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      const map = new Map();
      votes.push(map);

      const my = mySets[i];
      if (my !== undefined) {
        map.set(my, 10n);
      }
    }

    this.blocks.forEach((block) => {
      const work = block.work;
      if (work === undefined) {
        return;
      }

      let front: BlockFact | BlockSetFact = block;
      while (true) {
        if (Hash.equals(front.frontier, ZERO_HASH)) {
          const level = front.type === FactType.BlockSet ? front.level + 1 : 0;
          getOrCreate(votes[level], undefined, () => work, (acc) => acc + work);
          break;
        }
        const next = this.ctx.get(FactService).get(front.frontier);
        if (next === undefined) {
          break;
        }
        if (next.type !== FactType.BlockSet) {
          throw new Error(`Frontier doesn't refer to a blockset!`);
        }
        getOrCreate(votes[next.level], next, () => work, (acc) => acc + work);
        front = next;
      }
    });

    let prevVote: BlockSetFact | undefined;
    let size = 0;
    for (let i = NUM_BLOCKSET_LEVELS; i-- > 0;) {
      let bestBlockSet: BlockSetFact | undefined;
      let bestScore = -1n;
      votes[i].forEach((score, blockSet) => {
        if (
          blockSet !== undefined
            ? Hash.equals(
              blockSet.frontier,
              prevVote !== undefined ? prevVote.hash : ZERO_HASH,
            )
            : prevVote === undefined
        ) {
          if (score > bestScore) {
            bestBlockSet = blockSet;
            bestScore = score;
          }
        }
      });

      this.frontierSets[i] = bestBlockSet;
      prevVote = bestBlockSet;

      if (bestBlockSet !== undefined && i > size) {
        size = i;
      }
    }

    this.frontierSize = size;

    // TODO: Make sure our frontier is consistent (each one votes for the next up)
    // I think this is the case but we should double-check
  }
}
