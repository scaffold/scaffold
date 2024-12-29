import { BlockFact, FactSource } from './FactMeta.ts';
import { Context } from './Context.ts';
import { Hash, HASH_BITS, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
import { BlockService } from './BlockService.ts';
import { InputSpec } from './BlockBuilder.ts';
import { WeightService } from './WeightService.ts';
import { BlockOutput, FrontierTreeIoBranch, FrontierTreeIoEntry } from './messages.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { todo } from './util/functional.ts';
import { ClockService } from './ClockService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { error } from './util/functional.ts';
import { Verifier } from './messages.ts';
import { mapPut } from './util/map.ts';

const targLevel = 0;

// I don't think we need this
export const NUM_FRONTIER_LEVELS = 256;

if (frontierInputCount !== 2) {
  throw new Error(`FrontierService2.getRoot() needs to handle this case`);
}

export class FrontierService2 {
  private treeRoots: BlockFact[][] = [];

  constructor(private ctx: Context) {
    for (let i = 0; i < NUM_FRONTIER_LEVELS; i++) {
      this.treeRoots.push([]);
    }

    ctx.get(ClockService).setPoissonInterval(
      () => this.mergeAll(),
      ctx.config.backgroundJobParameters.frontierMergeIntervalMs,
    );
  }

  public mergeAll() {
    this.getRoot(NUM_FRONTIER_LEVELS - 1);
  }

  public getRoot(level: number): BlockFact | undefined {
    for (let i = 0; i <= level; i++) {
      while (this.treeRoots[i].length >= frontierInputCount) {
        this.mergeBlocks(this.treeRoots[i].slice(0, frontierInputCount));
      }
    }
    return this.treeRoots[level][0];
  }

  private mergeBlocks(blocks: BlockFact[]) {
    todo();
  }

  public mergeFrontierVotes(a: BlockFact, b: BlockFact) {
    if (a.frontierParams.level > b.frontierParams.level) {
      const t = a;
      a = b;
      b = t;
    }

    let it = a;
    while (it.frontierParams.level < b.frontierParams.level) {
      const vote = this.ctx.get(BlockService).get(it.frontierVote);
      if (vote === undefined) {
        return;
      }
      it = vote;
    }

    if (it === b) {
      return a;
    }
  }

  public mergeTreeWeights(
    inputs: InputSpec[],
    frontierVote: BlockFact | typeof ZERO_BLOCK,
  ): bigint[] {
    const weights: bigint[] = [];

    for (const input of inputs) {
      if (input.outputIdx !== input.block.frontierOutputIdx) {
        continue;
      }

      const selfWeight = this.ctx.get(WeightService).getSelfWeight(input.block);
      if (selfWeight.min !== selfWeight.max) {
        throw new Error(
          `Cannot merge an input block whose inputs are unknown!`,
        );
      }

      const voteDepth = frontierVote === ZERO_BLOCK ? -1 : frontierVote.frontierChainDepth ??
        error(`Unconnected frontier chain!`);
      const childDepth = input.block.frontierChainDepth ??
        error(`Unconnected frontier chain!`);
      const shift = childDepth - voteDepth - 1;

      const addWeight = (x: bigint, i: number) => {
        const idx = i > shift ? i - shift : 0;
        while (weights.length <= idx) {
          weights.push(0n);
        }
        weights[idx] += x;
      };

      input.block.frontierDetail.treeWeights.forEach(addWeight);
      addWeight(selfWeight.min, 0);
    }

    return weights;
  }

  public getBlockVote(inputs: { block: BlockFact; outputIdx?: number }[]) {
    if (inputs.length === 0) {
      // TODO: Choose a frontier at random; ZERO_HASH means that it can never be merged
      return ZERO_HASH;
    }

    const { frontierInputs, normalInputs } = Object.groupBy(
      inputs,
      (input) =>
        input.outputIdx !== undefined &&
          input.outputIdx === input.block.frontierOutputIdx
          ? 'frontierInputs'
          : 'normalInputs',
    );

    const frontierLevel = frontierInputs !== undefined
      ? frontierInputs[0].block.frontierParams.level + 1
      : 0;

    // debugger;

    // TODO: Reverse this arr
    const voteChain = [ZERO_HASH];
    const ensureInChain = (vote: Hash) => {
      if (frontierInputs !== undefined) {
        while (true) {
          const fi = frontierInputs.find((input) => Hash.equals(input.block.hash, vote));
          if (fi !== undefined) {
            vote = fi.block.frontierVote;
          } else {
            break;
          }
        }
      }

      if (voteChain.some((v) => Hash.equals(v, vote))) {
        return;
      }

      const idx = voteChain.length;
      const last = voteChain[idx - 1];

      let ptr = vote;
      do {
        const next = this.ctx.get(BlockService).get(ptr);
        if (next === undefined) {
          console.error(inputs);
          throw new Error(`Unconnected inputs!`);
        }
        if (next.frontierParams.level < frontierLevel) {
          throw new Error(
            `Level ${next.frontierParams.level} < ${frontierLevel}`,
          );
        }
        voteChain.splice(idx, 0, ptr);
        ptr = next.frontierVote;
      } while (!Hash.equals(ptr, last));
    };

    if (frontierInputs !== undefined) {
      for (const input of frontierInputs) {
        ensureInChain(input.block.frontierVote);
      }
    }

    if (normalInputs !== undefined) {
      for (const input of normalInputs) {
        ensureInChain(this.getTreeRoot(input.block).hash);
      }
    }

    return voteChain[voteChain.length - 1];
  }

  private getTreeRoot(block: BlockFact) {
    let ptr = block;
    while (true) {
      const { parent } = this.ctx.get(WeightService).getDescendant(ptr);
      if (parent) {
        ptr = parent;
      } else {
        return ptr;
      }
    }
  }
}
