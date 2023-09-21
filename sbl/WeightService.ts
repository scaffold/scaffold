import Context from '~/sbl/Context.ts';
import { BlockFact, FactType } from '~/sbl/FactMeta.ts';
import FrontierService from '~/sbl/FrontierService.ts';
import BlockSetService from '~/sbl/BlockSetService.ts';
import FreeMarketService from '~/sbl/FreeMarketService.ts';
import FactService from '~/sbl/FactService.ts';
import { BASE_WORK } from '~/sbl/BlockService.ts';

// When choosing an input, we compare blocks by D-(A+C), where D is the canonical derived work if C were canonical.

// Block/BlockSet .frontier -1> BlockSet .frontier -2> ... -3> BlockSet .left_child/.right_child -4> ... 5> Block

// Probe blocksets S that we receive.
//   If S becomes uncanonical, don't use it.
//   Track the percentage P of the work that we have blocks for.
//   The self work is S.work*P.
//   The derived work is the self+derived work of a single blockset V who voted for S or a parent of S, by maximizing derived-self work.
//   If we find an uncanonical block, tell everyone.

// A block's derived work is the sum over all outputs of D+S of the smallest claim by D-S.
//   How do we merge this with parents?

export default class WeightService {
  constructor(private ctx: Context) {}

  public getAncestorWeight(fact: BlockFact): bigint {
    throw new Error(`Not implemented`);
  }

  public computeSelfWeight(fact: BlockFact) {
    let inputFreeMarketSum = BASE_WORK;
    let isExact = true;
    for (const input of fact.inputs) {
      const block = this.ctx.get(FactService).get(input.block_hash);
      if (block !== undefined) {
        if (block.type !== FactType.Block) {
          throw new Error(`Invalid fact type!`);
        }
        const { verifier, amount } = block.outputs[input.output_idx];
        if (this.ctx.get(FreeMarketService).isFreeMarket(verifier)) {
          inputFreeMarketSum += amount;
        }
      } else {
        isExact = false;
      }
    }

    let outputCharitySum = 0n;
    for (const output of fact.outputs) {
      if (this.ctx.get(FreeMarketService).isCharity(output.verifier)) {
        outputCharitySum += output.amount;
      }
    }

    const minWeight = inputFreeMarketSum > outputCharitySum
      ? inputFreeMarketSum - outputCharitySum
      : 0n;

    return { minWeight, isExact };
  }

  public getSelfWeight(fact: BlockFact) {
    return this.computeSelfWeight(fact);
  }

  public getDescendantWeight(fact: BlockFact): bigint {
    const parents = this.ctx.get(BlockSetService).getParents(fact.hash);
    for (const parent of parents) {
      const selfWeight = this.getSelfWeight(parent);
      const descendantWeight = this.getDescendantWeight(parent);
      const score = descendantWeight - selfWeight;
      if (score > best.score) {
        best = { voter, score, weight: selfWeight + descendantWeight };
      }
    }

    if (fact.type === FactType.BlockSet) {
      let best: {
        voter?: BlockFact;
        score: number | bigint;
        weight: bigint;
      } = {
        score: -Infinity,
        weight: 0n,
      };
      const voters = this.ctx.get(FrontierService).getVotersFor(fact.hash);
      for (const voter of voters) {
        const selfWeight = this.getSelfWeight(voter);
        const descendantWeight = this.getDescendantWeight(voter);
        const score = descendantWeight - selfWeight;
        if (score > best.score) {
          best = { voter, score, weight: selfWeight + descendantWeight };
        }
      }
    }
  }
}
