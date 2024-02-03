import { BlockFact, FactSource } from './FactMeta.ts';
import { Context } from './Context.ts';
import { Hash, HASH_BITS, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
import { BlockService } from './BlockService.ts';
import { frontierHash } from './constants.ts';
import { InputSpec } from './BlockBuilder.ts';
import { WeightService } from './WeightService.ts';
import {
  BlockOutput,
  FrontierTreeIoBranch,
  FrontierTreeIoEntry,
} from './messages.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { todo } from './util/functional.ts';
import { ClockService } from './ClockService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { error } from './util/functional.ts';
import { Verifier } from './messages.ts';
import { mapPut } from './util/map.ts';

const targLevel = 0;

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
    outputs: BlockOutput[],
    frontierVote: BlockFact | typeof ZERO_BLOCK,
  ): bigint[] {
    const selfWeight = this.ctx.get(WeightService).getSelfWeight({
      source: FactSource.Local,
      inputs: inputs.map((input) => ({
        blockHash: input.block.hash,
        outputIdx: input.outputIdx,
        groupIdx: -1,
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
        const voteDepth = frontierVote === ZERO_BLOCK
          ? 0
          : frontierVote.frontierChainDepth ??
            error(`Unconnected frontier chain!`);
        const childDepth = input.block.frontierChainDepth ??
          error(`Unconnected frontier chain!`);
        const shift = voteDepth - childDepth + 1;

        input.block.frontierDetail.treeWeights.forEach((x, i) => {
          i += shift;
          if (i < 0) {
            i = 0;
          }
          while (weights.length <= i) {
            weights.push(0n);
          }
          weights[i] += x;
        });
      }
    }

    return weights;
  }

  public mergeTreeIo(inputs: { block: BlockFact; outputIdx?: number }[]) {
    // left frontier tree -> left frontier input block -> right frontier tree -> right frontier input block

    const consumedInputs = new Map<HashPrimitive, FrontierTreeIoBranch>();
    const producedOutputs = new Map<HashPrimitive, FrontierTreeIoBranch>();

    for (const input of inputs) {
      if (input.outputIdx === input.block.frontierOutputIdx) {
        this.iterateBranches(
          input.block.frontierDetail.consumedInputsRoot,
          (branch) => {
            const key = Hash.digest(FrontierTreeIoBranch.encode(branch));
            if (!producedOutputs.delete(key.toPrimitive())) {
              mapPut(
                consumedInputs,
                key.toPrimitive(),
                () => branch,
                () => error(`This merge would double-spend an input!`),
              );
            }
          },
        );

        this.iterateBranches(
          input.block.frontierDetail.producedOutputsRoot,
          (branch) => {
            const key = Hash.digest(FrontierTreeIoBranch.encode(branch));
            if (!consumedInputs.delete(key.toPrimitive())) {
              mapPut(
                producedOutputs,
                key.toPrimitive(),
                () => branch,
                () => error(`This merge would doubly-create an output!`),
              );
            }
          },
        );

        for (const input2 of input.block.inputs) {
          const inputBlock = this.ctx.get(BlockService)
            .get(input2.blockHash, false);
          if (inputBlock === undefined) {
            throw new Error(`Unknown frontier child input!`);
          }

          const branch = {
            path: Hash.digest(
              Verifier.encode(inputBlock.outputs[input2.outputIdx].verifier),
            ).toBigint() ^ (1n << BigInt(HASH_BITS)),
            childHash: input2.blockHash,
            outputIdx: input2.outputIdx,
            amount: inputBlock.outputs[input2.outputIdx].amount,
          };

          const key = Hash.digest(FrontierTreeIoBranch.encode(branch));
          if (!producedOutputs.delete(key.toPrimitive())) {
            mapPut(
              consumedInputs,
              key.toPrimitive(),
              () => branch,
              () => error(`This merge would double-spend an input!`),
            );
          }
        }

        let outputIdx = 0;
        for (const output2 of input.block.outputs) {
          const branch = {
            path: Hash.digest(Verifier.encode(output2.verifier)).toBigint() ^
              (1n << BigInt(HASH_BITS)),
            childHash: input.block.hash,
            outputIdx: outputIdx++,
            amount: output2.amount,
          };

          const key = Hash.digest(FrontierTreeIoBranch.encode(branch));
          if (!consumedInputs.delete(key.toPrimitive())) {
            mapPut(
              producedOutputs,
              key.toPrimitive(),
              () => branch,
              () => error(`This merge would doubly-create an output!`),
            );
          }
        }
      }
    }

    return {
      consumedInputsRoot: { branches: [...consumedInputs.values()] },
      producedOutputsRoot: { branches: [...producedOutputs.values()] },
    };
  }

  private iterateBranches(
    entry: FrontierTreeIoEntry,
    cb: (branch: FrontierTreeIoBranch) => void,
  ) {
    for (const branch of entry.branches) {
      if (branch.outputIdx === -1) {
        // TODO: Process childHash as another FrontierTreeIoEntry
        // Child entries will need to be passed the parent path(s), so they can add it into their key hashes.
        todo();
      } else if (branch.outputIdx < 0) {
        throw new Error(`Invalid outputIdx: ${branch.outputIdx}`);
      } else {
        // Process as a block IO entry
        cb(branch);
      }
    }
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
