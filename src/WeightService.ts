import { Context } from './Context.ts';
import { BlockFact, FactSource } from './FactMeta.ts';
import { ContractClassifierService } from './ContractClassifierService.ts';
import { BASE_WORK, BlockService } from './BlockService.ts';
import { bigintMax } from './util/bigint.ts';
import { Hash } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { ZERO_HASH } from './util/Hash.ts';
import { error } from './util/functional.ts';
import { FrontierChainService } from './FrontierChainService.ts';

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
  descendant: Map<
    BlockFact,
    { block?: BlockFact; weight: bigint; isParent: boolean }
  >;
  canonicality: Map<BlockFact, bigint>;
  canonicalVoter: Map<BlockFact | typeof ZERO_BLOCK, BlockFact | undefined>;
  canonicalParent: Map<BlockFact, BlockFact | undefined>;
  claimDelta: Map<BlockFact, bigint>;
  treeChildrenWeight: Map<BlockFact, { minWeight: bigint }>;
  voterWeight: Map<BlockFact, { minWeight: bigint }[]>;
}

export class WeightService {
  constructor(private ctx: Context) {}

  public makeCache(): Cache {
    return {
      ancestorWeight: new Map(),
      selfWeight: new Map(),
      descendant: new Map(),
      canonicality: new Map(),
      canonicalVoter: new Map(),
      canonicalParent: new Map(),
      claimDelta: new Map(),
      treeChildrenWeight: new Map(),
      voterWeight: new Map(),
    };
  }

  public getAncestorWeight(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.ancestorWeight, fact, () => {
      let minWeight = 0n;

      const block = this.ctx.get(BlockService).get(fact.frontierVote, false);
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
    cache = this.makeCache(),
  ) {
    return getOrCreate(cache.selfWeight, fact, () => {
      if (fact.source === FactSource.Genesis) {
        return { minWeight: BASE_WORK, maxWeight: BASE_WORK };
      }

      let inputKnownSum = 0n;
      let inputFreeMarketSum = 0n;
      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (block !== undefined) {
          const { verifier, amount } = block.outputs[input.outputIdx];
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

  public getDescendant(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.descendant, fact, () => {
      let bestScore = 0n;
      let bestDescendant: BlockFact | undefined;
      let bestDescendantWeight = 0n;
      let isParent = false;

      const factChain = this.ctx.get(FrontierChainService)
        .getFrontierChain(fact);
      const voters = this.ctx.get(BlockService).getVoters(fact.hash);

      for (const claim of fact.outputClaims[fact.frontierOutputIdx]) {
        debugger;

        const selfWeight = this.getSelfWeight(claim.block, cache).minWeight;
        const descWeight = this.getDescendant(claim.block, cache).weight;
        let coneWeight = 0n;
        let siblingWeight = 0n;
        for (const sibling of claim.block.inputs) {
          const siblingBlock = this.ctx.get(BlockService)
            .get(sibling.blockHash, false);
          if (
            siblingBlock !== undefined && siblingBlock !== fact &&
            siblingBlock.frontierOutputIdx === sibling.outputIdx
          ) {
            let ptr = siblingBlock;
            while (!factChain.has(ptr)) {
              coneWeight += this.getSelfWeight(ptr, cache).minWeight;
              coneWeight += ptr.frontierDetail.treeWeights
                .reduce((acc, cur) => acc + cur, 0n);
              ptr = ptr.frontierVoteBlock ?? error(`Unlinked sibling votes!`);
            }

            if (siblingBlock.frontierVoteBlock === fact) {
              siblingWeight +=
                this.getSelfWeight(siblingBlock, cache).minWeight;
              siblingWeight +=
                this.getVoterWeight(siblingBlock, cache)[0].minWeight;
            }
          }
        }
        const score = descWeight - selfWeight - coneWeight;
        if (bestDescendant === undefined || score > bestScore) {
          bestScore = score;
          bestDescendant = claim.block;
          bestDescendantWeight = selfWeight + descWeight + siblingWeight;
          isParent = true;
        }
      }

      for (const voter of voters) {
        const desc = this.getDescendant(voter, cache);
        if (!desc.isParent) {
          const selfWeight = this.getSelfWeight(voter, cache).minWeight;
          const voterWeight = this.getVoterWeight(voter, cache)[0].minWeight;
          const score = desc.weight - selfWeight + voterWeight;
          if (bestDescendant === undefined || score > bestScore) {
            bestScore = score;
            bestDescendant = voter;
            bestDescendantWeight = selfWeight + desc.weight + voterWeight;
            isParent = false;
          }
        }
      }

      return { block: bestDescendant, weight: bestDescendantWeight, isParent };

      // let minWeight = 0n;

      // let count = 0;
      // for (const claim of fact.outputClaims[fact.frontierOutputIdx]) {
      //   if (this.getClaimDelta(claim.block, cache) >= 0n) {
      //     minWeight += this.getSelfWeight(claim.block, cache).minWeight;
      //     minWeight += this.getDescendantWeight(claim.block, cache).minWeight;
      //     count++;
      //   }
      // }

      // if (count === 0) {
      //   const bestVoter = this.getCanonicalVoter(fact, cache);
      //   if (bestVoter !== undefined) {
      //     minWeight += this.getVoterWeight(bestVoter, cache)[0].minWeight;
      //   }
      // } else if (count > 1) {
      //   throw new Error(`More than one canonical frontier output!`);
      // }

      // return { minWeight };
    });
  }

  public isCanonical(fact: BlockFact, cache = this.makeCache()) {
    return this.getCanonicality(fact, cache) >= 0n;
  }

  public getCanonicality(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.canonicality, fact, () => {
      const selfWeight = this.getSelfWeight(fact, cache).minWeight;
      const descWeight = this.getDescendant(fact, cache).weight;
      let canonicality = selfWeight + descWeight;

      const parent = this.ctx.get(BlockService).get(fact.frontierVote, false);
      if (parent !== undefined) {
        const parentCanonicality = this.getCanonicality(parent, cache);
        if (parentCanonicality < canonicality) {
          canonicality = parentCanonicality;
        }
      }

      for (const input of fact.inputs) {
        const parent = this.ctx.get(BlockService).get(input.blockHash, false);
        if (
          parent !== undefined && parent.frontierOutputIdx === input.outputIdx
        ) {
          const parentCanonicality = this.getCanonicality(parent, cache);
          if (parentCanonicality < canonicality) {
            canonicality = parentCanonicality;
          }
        }
      }

      return canonicality;

      // let canonicality = this.getClaimDelta(fact, cache);

      // const block = this.ctx.get(BlockService).get(fact.frontierVote, false);
      // if (block !== undefined) {
      //   const delta = this.getClaimDelta(block, cache);
      //   if (delta < canonicality) {
      //     canonicality = delta;
      //   }
      // }

      // for (const input of fact.inputs) {
      //   const block = this.ctx.get(BlockService).get(input.blockHash, false);
      //   if (block !== undefined) {
      //     const delta = this.getClaimDelta(block, cache);
      //     if (delta < canonicality) {
      //       canonicality = delta;
      //     }
      //   }
      // }

      // return canonicality;
    });
  }

  public getCanonicalVoter(
    fact: BlockFact | typeof ZERO_BLOCK,
    cache = this.makeCache(),
  ) {
    return getOrCreate(cache.canonicalVoter, fact, () => {
      const voters = this.ctx.get(BlockService).getVoters(
        fact === ZERO_BLOCK ? ZERO_HASH : fact.hash,
      );

      let bestScore = 0n;
      let bestVoter: BlockFact | undefined;
      for (const voter of voters) {
        // TODO: Should this be based on the voter weight?
        const score = this.getDescendant(voter, cache).weight +
          this.getSelfWeight(voter, cache).minWeight;
        if (score > bestScore) {
          bestScore = score;
          bestVoter = voter;
        }
      }

      return bestVoter;
    });
  }

  public getCanonicalParent(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.canonicalParent, fact, () => {
      const parents = fact.outputClaims[fact.frontierOutputIdx];

      let bestScore = -1n;
      let bestParent: BlockFact | undefined;
      for (const claim of parents) {
        // TODO: Should this be based on the parent weight?
        const score = this.getCanonicality(claim.block, cache);
        if (score > bestScore) {
          bestScore = score;
          bestParent = claim.block;
        }
      }

      return bestParent;
    });
  }

  private getClaimDelta(fact: BlockFact, cache = this.makeCache()) {
    // TODO: This should be based on:
    // 1. input siblings,
    // 2. frontier vote siblings,
    // 3. frontier vote tree parents, and
    // 4. tree child frontier voters

    return getOrCreate(cache.claimDelta, fact, () => {
      const myDescendantWeight = this.getDescendant(fact, cache).weight;
      const mySelfWeight = this.getSelfWeight(fact, cache).maxWeight;
      let minDelta = myDescendantWeight;

      for (const input of fact.inputs) {
        const claims = this.ctx.get(BlockService).getClaims(input);
        // if (claims.length !== 1) {
        if (claims.length === 0) {
          throw new Error(`Blocks not linked!`);
        }

        for (const claim of claims) {
          if (claim.block !== fact) {
            let delta = myDescendantWeight -
              this.getDescendant(claim.block, cache).weight +
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

      return minDelta;
    });
  }

  private getTreeChildrenWeight(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.treeChildrenWeight, fact, () => {
      let minWeight = 0n;

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (
          block !== undefined && input.outputIdx === block.frontierOutputIdx
        ) {
          minWeight += this.getSelfWeight(block, cache).minWeight;
          minWeight += this.getTreeChildrenWeight(block, cache).minWeight;
        }
      }

      return { minWeight };
    });
  }

  /**
   * Returns an array of weights, one for each block in the ancestor frontier vote chain.
   * result[0] is the weight of blocks in the tree voting for frontierVote.
   * result[1] is the weight of blocks in the tree voting for frontierVote.frontierVote.
   */
  public getVoterWeight(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.voterWeight, fact, () => {
      const desc = this.getDescendant(fact, cache);

      if (desc.block === undefined || desc.isParent) {
        const res = fact.frontierDetail.treeWeights
          .map((x) => ({ minWeight: x }));
        if (res.length === 0) {
          res.push({ minWeight: 0n });
        }
        return res;
      }

      const subWeight = this.getVoterWeight(desc.block, cache);

      const res: { minWeight: bigint }[] = [];
      for (let i = 0; true; i++) {
        const selfEl = fact.frontierDetail.treeWeights[i];
        const subEl = subWeight[i + 1];
        if (selfEl !== undefined) {
          if (subEl !== undefined) {
            res.push({ minWeight: selfEl + subEl.minWeight });
          } else {
            res.push({ minWeight: selfEl });
          }
        } else {
          if (subEl !== undefined) {
            res.push(subEl);
          } else {
            break;
          }
        }
      }

      if (res.length === 0) {
        res.push({ minWeight: 0n });
      }
      res[0].minWeight += subWeight[0].minWeight;

      return res;

      // let minWeight = 0n;

      // for (const voter of fact.frontierVoters) {
      //   if (this.getClaimDelta(voter, cache) >= 0n) {
      //     minWeight += this.getSelfWeight(voter, cache).minWeight;
      //     minWeight += this.getVoterWeight(voter, cache).minWeight;
      //   }
      // }

      // return { minWeight };
    });
  }
}
