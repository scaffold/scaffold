import { BlockFact, FactSource } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import BlockService from '~/sbl/BlockService.ts';
import { frontierHash } from '~/sbl/constants.ts';
import { InputSpec } from '~/sbl/BlockBuilder.ts';
import WeightService from '~/sbl/WeightService.ts';
import { BlockOutput } from '~/sbl/messages.ts';
import { frontierInputCount } from '~/sbl/contracts/FrontierContract.ts';
import { todo } from '~/sbl/util/functional.ts';
import ClockService from '~/sbl/ClockService.ts';

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
      const vote = this.ctx.get(BlockService).get(it.frontier_vote);
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
        block_hash: input.block.hash,
        output_idx: input.outputIdx,
      })),
      outputs,
    }).minWeight;
    const weights = [selfWeight];

    for (const input of inputs) {
      if (
        Hash.equals(
          input.block.outputs[input.outputIdx].verifier.contract_hash,
          frontierHash,
        )
      ) {
        let ptr = frontierVote;
        let offset = 0;
        while (!Hash.equals(ptr, input.block.frontier_vote)) {
          const next = this.ctx.get(BlockService).get(ptr, false);
          if (next === undefined) {
            throw new Error(`Unconnected inputs!`);
          }
          ptr = next.frontier_vote;
          offset++;
        }

        input.block.frontierDetail.tree_weights.forEach((x, i) => {
          const idx = offset + i;
          while (weights.length <= idx) {
            weights.push(0n);
          }
          weights[idx] += x;
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
            input.block.outputs[input.outputIdx].verifier.contract_hash,
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
            vote = fi.block.frontier_vote;
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
        ptr = next.frontier_vote;
      } while (!Hash.equals(ptr, last));
    };

    if (frontierInputs !== undefined) {
      for (const input of frontierInputs) {
        ensureInChain(input.block.frontier_vote);
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
