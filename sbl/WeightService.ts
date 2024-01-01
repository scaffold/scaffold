import Context from '~/sbl/Context.ts';
import { BlockFact, FactSource } from '~/sbl/FactMeta.ts';
import ContractClassifierService from '~/sbl/ContractClassifierService.ts';
import BlockService, { BASE_WORK } from '~/sbl/BlockService.ts';
import { bigintMax } from '~/sbl/util/bigint.ts';
import { frontierHash } from '~/sbl/constants.ts';
import Hash from '~/sbl/util/Hash.ts';
import { getOrCreate } from '~/sbl/util/map.ts';

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

interface Cache {
  ancestorWeight: Map<BlockFact, { minWeight: bigint }>;
  selfWeight: Map<BlockFact, { minWeight: bigint; maxWeight: bigint }>;
  descendantWeight: Map<BlockFact, { minWeight: bigint }>;
  canonicality: Map<BlockFact, bigint>;
  claimDelta: Map<BlockFact, bigint>;
  treeChildrenWeight: Map<BlockFact, { minWeight: bigint }>;
  voterWeight: Map<BlockFact, { minWeight: bigint }>;
}
const makeCache = (): Cache => ({
  ancestorWeight: new Map(),
  selfWeight: new Map(),
  descendantWeight: new Map(),
  canonicality: new Map(),
  claimDelta: new Map(),
  treeChildrenWeight: new Map(),
  voterWeight: new Map(),
});

export default class WeightService {
  constructor(private ctx: Context) {}

  public getAncestorWeight(fact: BlockFact, cache = makeCache()) {
    return getOrCreate(cache.ancestorWeight, fact, () => {
      let minWeight = 0n;

      const block = this.ctx.get(BlockService).get(fact.frontier_vote, false);
      if (block !== undefined) {
        minWeight += this.getSelfWeight(block, cache).minWeight;
        minWeight += this.getAncestorWeight(block, cache).minWeight;
      }

      minWeight += this.getTreeChildrenWeight(fact, cache).minWeight;

      return { minWeight };
    });
  }

  public getSelfWeight(
    fact: Pick<BlockFact, 'source' | 'inputs' | 'outputs'>,
    cache = makeCache(),
  ) {
    return getOrCreate(cache.selfWeight, fact, () => {
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
        if (
          this.ctx.get(ContractClassifierService).isCharity(output.verifier)
        ) {
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
    });
  }

  public getDescendantWeight(fact: BlockFact, cache = makeCache()) {
    return getOrCreate(cache.descendantWeight, fact, () => {
      let minWeight = 0n;

      for (const claim of fact.outputClaims[fact.frontierOutputIdx]) {
        if (this.getClaimDelta(claim.block, cache) >= 0n) {
          minWeight += this.getSelfWeight(claim.block, cache).minWeight;
          minWeight += this.getDescendantWeight(claim.block, cache).minWeight;
        }
      }

      minWeight += this.getVoterWeight(fact, cache).minWeight;

      return { minWeight };
    });
  }

  public isCanonical(fact: BlockFact, cache = makeCache()) {
    return this.getCanonicality(fact, cache) >= 0n;
  }

  public getCanonicality(fact: BlockFact, cache = makeCache()) {
    return getOrCreate(cache.canonicality, fact, () => {
      let canonicality = this.getClaimDelta(fact, cache);

      const block = this.ctx.get(BlockService).get(fact.frontier_vote, false);
      if (block !== undefined) {
        const delta = this.getClaimDelta(block, cache);
        if (delta < canonicality) {
          canonicality = delta;
        }
      }

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.block_hash, false);
        if (block !== undefined) {
          const delta = this.getClaimDelta(block, cache);
          if (delta < canonicality) {
            canonicality = delta;
          }
        }
      }

      return canonicality;
    });
  }

  private getClaimDelta(fact: BlockFact, cache = makeCache()) {
    return getOrCreate(cache.claimDelta, fact, () => {
      const myDescendantWeight =
        this.getDescendantWeight(fact, cache).minWeight;
      const mySelfWeight = this.getSelfWeight(fact, cache).maxWeight;
      let minDelta = myDescendantWeight;

      // TODO: Iterate claims/voters of the frontier_vote here as well?
      // YES!!! This ensures only one voter becomes canonical.

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.block_hash, false);
        if (block !== undefined) {
          const claims = block.outputClaims[input.output_idx];
          // if (claims.length !== 1) {
          if (claims.length === 0) {
            debugger;
            throw new Error(`Blocks not linked!`);
          }

          for (const claim of claims) {
            if (claim.block !== fact) {
              let delta = myDescendantWeight -
                this.getDescendantWeight(claim.block, cache).minWeight +
                this.getSelfWeight(claim.block, cache).maxWeight - mySelfWeight;
              if (delta === 0n) {
                // Resolve ties by locally promoting the block that comes first
                for (const claim2 of claims) {
                  if (claim2.block === fact) {
                    break;
                  } else if (claim2.block === claim.block) {
                    delta--;
                    break;
                  }
                }
              }
              if (delta < minDelta) {
                minDelta = delta;
              }
            }
          }

          // }
        }
      }

      return minDelta;
    });
  }

  private getTreeChildrenWeight(fact: BlockFact, cache = makeCache()) {
    return getOrCreate(cache.treeChildrenWeight, fact, () => {
      let minWeight = 0n;

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.block_hash, false);
        if (block !== undefined) {
          const { verifier } = block.outputs[input.output_idx];
          if (Hash.equals(verifier.contract_hash, frontierHash)) {
            minWeight += this.getSelfWeight(block, cache).minWeight;
            minWeight += this.getTreeChildrenWeight(block, cache).minWeight;
          }
        }
      }

      return { minWeight };
    });
  }

  private getVoterWeight(fact: BlockFact, cache = makeCache()) {
    return getOrCreate(cache.voterWeight, fact, () => {
      let minWeight = 0n;

      for (const voter of fact.frontierVoters) {
        if (this.getClaimDelta(voter, cache) >= 0n) {
          minWeight += this.getSelfWeight(voter, cache).minWeight;
          minWeight += this.getVoterWeight(voter, cache).minWeight;
        }
      }

      return { minWeight };
    });
  }
}
