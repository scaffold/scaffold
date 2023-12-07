import Context from '~/sbl/Context.ts';
import { BlockFact, FactSource } from '~/sbl/FactMeta.ts';
import ContractClassifierService from '~/sbl/ContractClassifierService.ts';
import BlockService, { BASE_WORK } from '~/sbl/BlockService.ts';
import { bigintMax } from '~/sbl/util/bigint.ts';
import { frontierHash } from '~/sbl/constants.ts';
import Hash from '~/sbl/util/Hash.ts';

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

/*
Propagate derived work towards frontier_vote and frontier inputs. Choose and propagate canonicality forwards.
When we get a block or increment the work, propagate it towards frontier_vote.
To get the derived work, fetch the descendant work property of our block, and that of all recursive parent (frontier output claim) blocks.
When we have multiple claimants of an output, simply choose the highest-scoring by D-S and set all other works to zero or the minimum.
*/

// OPTIMIZATION:
// Always propogate weights towards the frontier, which is bounded by log(N)

export default class WeightService {
  constructor(private ctx: Context) {}

  public getAncestorWeight(fact: BlockFact) {
    let minWeight = 0n;

    const block = this.ctx.get(BlockService).get(fact.frontier_vote, false);
    if (block !== undefined) {
      minWeight += this.getSelfWeight(block).minWeight;
      minWeight += this.getAncestorWeight(block).minWeight;
    }

    minWeight += this.getTreeChildrenWeight(fact).minWeight;

    return { minWeight };
  }

  public getSelfWeight(fact: Pick<BlockFact, 'source' | 'inputs' | 'outputs'>) {
    if (fact.source === FactSource.Genesis) {
      return { minWeight: BASE_WORK, maxWeight: BASE_WORK };
    }

    let inputKnownSum = 0n;
    let inputFreeMarketSum = 0n;
    for (const input of fact.inputs) {
      const block = this.ctx.get(BlockService).get(input.block_hash, false);
      if (block !== undefined) {
        const { verifier, amount } = block.outputs[input.output_idx];
        inputKnownSum += amount;
        if (this.ctx.get(ContractClassifierService).isFreeMarket(verifier)) {
          inputFreeMarketSum += amount;
        }
      }
    }

    let outputSum = 0n;
    let outputCharitySum = 0n;
    for (const output of fact.outputs) {
      outputSum += output.amount;
      if (this.ctx.get(ContractClassifierService).isCharity(output.verifier)) {
        outputCharitySum += output.amount;
      }
    }

    const minWeight = bigintMax(
      0n,
      BASE_WORK + inputFreeMarketSum - outputCharitySum,
    );
    const maxWeight = bigintMax(
      0n,
      BASE_WORK + inputFreeMarketSum + outputSum - inputKnownSum -
        outputCharitySum,
    );

    return { minWeight, maxWeight };
  }

  public getDescendantWeight(fact: BlockFact) {
    let minWeight = 0n;

    for (const claim of fact.outputClaims[fact.frontierOutputIdx]) {
      if (this.isHeaviestClaim(claim.block)) {
        minWeight += this.getSelfWeight(claim.block).minWeight;
        minWeight += this.getDescendantWeight(claim.block).minWeight;
      }
    }

    minWeight += this.getVoterWeight(fact).minWeight;

    return { minWeight };
  }

  public isCanonical(fact: BlockFact) {
    const block = this.ctx.get(BlockService).get(fact.frontier_vote, false);
    if (block !== undefined && !this.isCanonical(block)) {
      return false;
    }

    for (const input of fact.inputs) {
      const block = this.ctx.get(BlockService).get(input.block_hash, false);
      if (block !== undefined && !this.isCanonical(block)) {
        return false;
      }
    }

    return this.isHeaviestClaim(fact);
  }

  private isHeaviestClaim(fact: BlockFact) {
    for (const input of fact.inputs) {
      const block = this.ctx.get(BlockService).get(input.block_hash, false);
      if (block !== undefined) {
        const claims = block.outputClaims[input.output_idx];
        // if (claims.length !== 1) {
        if (claims.length === 0) {
          throw new Error(`Blocks not linked!`);
        }

        let bestClaim: BlockFact | undefined;
        let bestScore: bigint | undefined;
        for (const claim of claims) {
          const score = this.getDescendantWeight(claim.block).minWeight -
            this.getSelfWeight(claim.block).maxWeight;
          if (bestScore === undefined || score > bestScore) {
            bestClaim = claim.block;
            bestScore = score;
          }
        }

        if (bestClaim !== fact) {
          return false;
        }
        // }
      }
    }
    return true;
  }

  private getTreeChildrenWeight(fact: BlockFact) {
    let minWeight = 0n;

    for (const input of fact.inputs) {
      const block = this.ctx.get(BlockService).get(input.block_hash, false);
      if (block !== undefined) {
        const { verifier } = block.outputs[input.output_idx];
        if (Hash.equals(verifier.contract_hash, frontierHash)) {
          minWeight += this.getSelfWeight(block).minWeight;
          minWeight += this.getTreeChildrenWeight(block).minWeight;
        }
      }
    }

    return { minWeight };
  }

  private getVoterWeight(fact: BlockFact) {
    let minWeight = 0n;

    for (const voter of fact.frontierVoters) {
      if (this.isHeaviestClaim(voter)) {
        minWeight += this.getSelfWeight(voter).minWeight;
        minWeight += this.getVoterWeight(voter).minWeight;
      }
    }

    return { minWeight };
  }
}
