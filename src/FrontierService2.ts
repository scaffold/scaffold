import { BlockFact, FactSource } from './FactMeta.ts';
import Context from './Context.ts';
import Hash, { ZERO_HASH } from './util/Hash.ts';
import BlockService from './BlockService.ts';
import { frontierHash } from './constants.ts';
import { InputSpec } from './BlockBuilder.ts';
import WeightService from './WeightService.ts';
import { BlockOutput } from './messages.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { todo } from './util/functional.ts';
import ClockService from './ClockService.ts';

const targLevel = 0;

export const NUM_FRONTIER_LEVELS = 64;

if (frontierInputCount !== 2) {
  throw new Error(`FrontierService2.getRoot() needs to handle this case`);
}

export default class FrontierService2 {
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
    outputs: BlockOutput[],
    frontierVote: Hash,
  ): bigint[] {
    const selfWeight = this.ctx.get(WeightService).getSelfWeight({
      source: FactSource.Local,
      inputs: inputs.map((input) => ({
        blockHash: input.block.hash,
        outputIdx: input.outputIdx,
        groupIdx: todo(),
      })),
      outputs,
    }).minWeight;
    const weights = [selfWeight];

    for (const input of inputs) {
      if (
        Hash.equals(
          input.block.outputs[input.outputIdx].verifier.contractHash,
          frontierHash,
        )
      ) {
        let ptr = input.block.frontierVote;
        let shift = 0;
        while (!Hash.equals(ptr, frontierVote)) {
          const next = this.ctx.get(BlockService).get(ptr, false);
          if (next === undefined) {
            throw new Error(`Unconnected inputs!`);
          }
          ptr = next.frontierVote;
          shift++;
        }

        input.block.frontierDetail.treeWeights.forEach((x, i) => {
          weights[i > shift ? i - shift : 0] += x;
        });
      }
    }

    return weights;
  }

  // TODO: How should we handle refs here?
  public getBlockVote(inputs: InputSpec[]): Hash {
    if (inputs.length === 0) {
      // TODO: Choose a frontier at random; ZERO_HASH means that it can never be merged
      return ZERO_HASH;
    }

    const { frontierInputs, normalInputs } = Object.groupBy(
      inputs,
      (input) =>
        Hash.equals(
            input.block.outputs[input.outputIdx].verifier.contractHash,
            frontierHash,
          )
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
          const fi = frontierInputs.find((input) =>
            Hash.equals(input.block.hash, vote)
          );
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
        const next = this.ctx.get(BlockService).get(ptr, false);
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
    while (true) {
      let bestScore: bigint | undefined;
      let bestDescendant: BlockFact | undefined;
      for (const claim of block.outputClaims[block.frontierOutputIdx]) {
        const score = this.ctx.get(WeightService).getCanonicality(claim.block);
        if (bestDescendant === undefined || score > bestScore!) {
          bestScore = score;
          bestDescendant = claim.block;
        }
      }

      if (bestDescendant !== undefined) {
        block = bestDescendant;
      } else {
        return block;
      }
    }
  }
}
