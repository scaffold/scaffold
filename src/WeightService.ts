import { Context } from './Context.ts';
import { BlockFact, FactSource } from './FactMeta.ts';
import { ContractClassifierService } from './ContractClassifierService.ts';
import { BASE_WORK, BlockService } from './BlockService.ts';
import { bigintMax } from './util/bigint.ts';
import { mapPut } from './util/map.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { FrontierChainService } from './FrontierChainService.ts';
import { OutputClaim } from './BlockMeta.ts';

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

const useTreeWeightForChildren = true;

interface DescendantResult {
  parent?: BlockFact;
  voters: BlockFact[];

  leaves: BlockFact[];
  weight: bigint;
}

interface Cache {
  selfWeight: Map<BlockFact, { min: bigint; max: bigint }>;
  selfOffset: Map<BlockFact, { min: bigint; max: bigint }>;
  ancestorWeight: Map<BlockFact, bigint>;
  ancestorOffset: Map<BlockFact, bigint>;
  descendant: Map<BlockFact, DescendantResult>;
  canonicality: Map<BlockFact, { canonicality: bigint; usurper?: OutputClaim }>;
  claimCanonicality: Map<
    BlockFact,
    { canonicality: bigint; usurper?: OutputClaim }
  >;
  canonicalVoter: Map<BlockFact | typeof ZERO_BLOCK, BlockFact | undefined>;
  canonicalParent: Map<BlockFact, BlockFact | undefined>;
  claimDelta: Map<BlockFact, bigint>;
  treeChildrenWeight: Map<BlockFact, bigint>;
  treeChildrenOffset: Map<BlockFact, bigint>;
  voterWeight: Map<BlockFact, bigint[]>;
}

export class WeightService {
  private cache: Cache = this.makeCache();

  constructor(private ctx: Context) {}

  public resetCache() {
    this.cache = this.makeCache();
  }

  private makeCache(): Cache {
    return {
      selfWeight: new Map(),
      selfOffset: new Map(),
      ancestorWeight: new Map(),
      ancestorOffset: new Map(),
      descendant: new Map(),
      canonicality: new Map(),
      claimCanonicality: new Map(),
      canonicalVoter: new Map(),
      canonicalParent: new Map(),
      claimDelta: new Map(),
      treeChildrenWeight: new Map(),
      treeChildrenOffset: new Map(),
      voterWeight: new Map(),
    };
  }

  private getCache() {
    return this.cache;
  }

  public getSelfWeight(fact: BlockFact, cache = this.getCache()) {
    return mapPut(cache.selfWeight, fact, () => {
      if (fact.source === FactSource.Genesis) {
        return { min: BASE_WORK, max: BASE_WORK };
      }

      let inputPositivePersonal = 0n;
      let inputPositiveSocial = 0n;
      let inputPositiveCharity = 0n;
      let inputNegativePersonal = 0n;
      let inputNegativeSocial = 0n;
      let inputNegativeCharity = 0n;
      let outputPositivePersonal = 0n;
      let outputPositiveSocial = 0n;
      let outputPositiveCharity = 0n;
      let outputNegativePersonal = 0n;
      let outputNegativeSocial = 0n;
      let outputNegativeCharity = 0n;

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (block !== undefined) {
          const { verifier, amount } = block.outputs[input.outputIdx];
          if (this.ctx.get(ContractClassifierService).isCharity(verifier)) {
            if (amount >= 0n) {
              inputPositiveCharity += amount;
            } else {
              inputNegativeCharity += amount;
            }
          } else if (
            this.ctx.get(ContractClassifierService).isFreeMarket(verifier)
          ) {
            if (amount >= 0n) {
              inputPositiveSocial += amount;
            } else {
              inputNegativeSocial += amount;
            }
          } else {
            if (amount >= 0n) {
              inputPositivePersonal += amount;
            } else {
              inputNegativePersonal += amount;
            }
          }
        }
      }

      for (const { verifier, amount } of fact.outputs) {
        if (this.ctx.get(ContractClassifierService).isCharity(verifier)) {
          if (amount >= 0n) {
            outputPositiveCharity += amount;
          } else {
            outputNegativeCharity += amount;
          }
        } else if (
          this.ctx.get(ContractClassifierService).isFreeMarket(verifier)
        ) {
          if (amount >= 0n) {
            outputPositiveSocial += amount;
          } else {
            outputNegativeSocial += amount;
          }
        } else {
          if (amount >= 0n) {
            outputPositivePersonal += amount;
          } else {
            outputNegativePersonal += amount;
          }
        }
      }

      const inputKnownSum = inputPositiveCharity + inputNegativeCharity +
        inputPositiveSocial + inputNegativeSocial + inputPositivePersonal +
        inputNegativePersonal;
      const inputFreeMarketSum = inputPositiveCharity + inputNegativeCharity +
        inputPositiveSocial + inputNegativeSocial;
      const outputSum = outputPositiveCharity + outputNegativeCharity +
        outputPositiveSocial + outputNegativeSocial + outputPositivePersonal +
        outputNegativePersonal;
      const outputCharitySum = outputPositiveCharity + outputNegativeCharity;

      let min = bigintMax(BASE_WORK, inputFreeMarketSum - outputCharitySum);
      let max = bigintMax(
        BASE_WORK,
        inputFreeMarketSum + outputSum - inputKnownSum - outputCharitySum,
      );

      const factAgeMs = this.ctx.config.timeProvider.now() - fact.receivedAt;
      const workLimit = this.ctx.config.getWeightLimit(factAgeMs);
      if (min > workLimit) {
        min = workLimit;
      }
      if (max > workLimit) {
        max = workLimit;
      }

      return { min, max };
    });
  }

  public getSelfOffset(fact: BlockFact, cache = this.getCache()) {
    return mapPut(cache.selfOffset, fact, () => {
      let minSiblingWeight = this.getSelfWeight(fact, cache).max;

      let minRecvTime = Infinity;
      if (
        fact.frontierVoteBlock !== undefined &&
        fact.frontierVoteBlock.receivedAt < minRecvTime
      ) {
        minRecvTime = fact.frontierVoteBlock.receivedAt;
      }

      // const voters = this.ctx.get(BlockService).getVoters(fact.frontierVote);
      // for (const voter of voters) {
      //   if (voter.receivedAt < minRecvTime) {
      //     minRecvTime = voter.receivedAt;
      //   }

      //   const siblingWeight = this.getSelfWeight(voter, cache).max;
      //   if (siblingWeight < minSiblingWeight) {
      //     minSiblingWeight = siblingWeight;
      //   }
      // }

      // if (minRecvTime === Infinity) {
      //   throw new Error(`No voters for frontier vote!`);
      // }

      // const workLimit = this.ctx.config.getWeightLimit(
      //   this.ctx.config.timeProvider.now() - minRecvTime,
      // );
      // if (workLimit < minSiblingWeight) {
      //   minSiblingWeight = workLimit;
      // }

      for (const input of fact.inputs) {
        let minRecvTime = Infinity;
        const parent = this.ctx.get(BlockService).get(input.blockHash, false);
        if (parent !== undefined && parent.receivedAt < minRecvTime) {
          minRecvTime = parent.receivedAt;
        }

        const claims = this.ctx.get(BlockService).getClaims(input);
        for (const claim of claims) {
          if (claim.block.receivedAt < minRecvTime) {
            minRecvTime = claim.block.receivedAt;
          }

          const siblingWeight = this.getSelfWeight(claim.block, cache).max;
          if (siblingWeight < minSiblingWeight) {
            minSiblingWeight = siblingWeight;
          }
        }

        if (minRecvTime === Infinity) {
          throw new Error(`No claims for input!`);
        }

        const workLimit = this.ctx.config.getWeightLimit(
          this.ctx.config.timeProvider.now() - minRecvTime,
        );
        if (workLimit < minSiblingWeight) {
          minSiblingWeight = workLimit;
        }
      }

      const overpayment = this.getSelfWeight(fact, cache).max -
        minSiblingWeight;
      const penalty = this.ctx.config.getOverpaymentPenalty(overpayment);
      const min = -overpayment - penalty;
      const max = min;

      return { min, max };
    });
  }

  public getAncestorWeight(fact: BlockFact, cache = this.getCache()) {
    return mapPut(cache.ancestorWeight, fact, () => {
      let minWeight = 0n;

      const block = this.ctx.get(BlockService).get(fact.frontierVote, false);
      if (block !== undefined) {
        minWeight += this.getSelfWeight(block, cache).min;
        minWeight += this.getAncestorWeight(block, cache);
      }

      minWeight += this.getTreeChildrenWeight(fact, cache);

      return minWeight;
    });
  }

  public getAncestorOffset(fact: BlockFact, cache = this.getCache()) {
    return mapPut(cache.ancestorOffset, fact, () => {
      let offset = 0n;

      const block = this.ctx.get(BlockService).get(fact.frontierVote, false);
      if (block !== undefined) {
        offset += this.getSelfOffset(block, cache).min;
        offset += this.getAncestorOffset(block, cache);
      }

      offset += this.getTreeChildrenOffset(fact, cache);

      return offset;
    });
  }

  /**
   * Returns some properties related to the descendants of the given block:
   * - block: The most canonical immediate descendant (either a parent or frontier voter), or undefined if none
   * - isParent: Whether the returned descendant is a parent, or false if none
   */
  public getDescendant(
    fact: BlockFact,
    cache = this.getCache(),
  ): DescendantResult {
    return mapPut(cache.descendant, fact, () => {
      // TODO: We might have to look at parent vote's canonicalities

      let selfWeight = this.getSelfWeight(fact, cache).min;

      for (const input of fact.inputs) {
        const claims = this.ctx.get(BlockService).getClaims(input);
        if (claims.length === 0) {
          throw new Error(`Input claims is empty!`);
        }
        const minWeight = claims
          .map((x) => this.getSelfWeight(x.block, cache).min)
          .reduce((x, y) => x < y ? x : y);
        if (minWeight < selfWeight) {
          selfWeight = minWeight;
        }
      }

      // TODO: Add in the penalty here?

      const parent = fact.outputClaims[fact.frontierOutputIdx].find((x) =>
        this.getClaimCanonicality(x.block, fact, cache).canonicality >= 0n
      );
      if (parent !== undefined) {
        let siblingWeight = 0n;
        for (const sibling of parent.block.inputs) {
          const siblingBlock = this.ctx.get(BlockService)
            .get(sibling.blockHash, false);
          if (
            siblingBlock !== undefined && siblingBlock !== fact &&
            siblingBlock.frontierOutputIdx === sibling.outputIdx &&
            siblingBlock.frontierVoteBlock === fact
          ) {
            siblingWeight += this.getSelfWeight(siblingBlock, cache).min;
            siblingWeight += siblingBlock.frontierDetail.treeWeights[0] ?? 0n;
          }
        }

        const desc = this.getDescendant(parent.block, cache);
        return {
          parent: parent.block,
          voters: [],
          leaves: desc.leaves,
          weight: selfWeight + siblingWeight + desc.weight,
        };
      }

      const voters = fact.frontierVoters.filter((x) => {
        const candidate = this.getDescendant(x, cache);
        return candidate.parent === undefined &&
          this.getClaimCanonicality(x, fact, cache).canonicality >= 0n;
      });
      return {
        voters,
        leaves: [
          fact,
          ...voters.flatMap((x) => this.getDescendant(x, cache).leaves),
        ],
        weight: voters.reduce(
          (acc, cur) =>
            acc + (this.getVoterWeight(cur, cache)[0] ?? 0n) +
            this.getDescendant(cur, cache).weight,
          selfWeight,
        ),
      };

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
      //     minWeight += this.getVoterWeight(bestVoter, cache)[0] ?? 0n;
      //   }
      // } else if (count > 1) {
      //   throw new Error(`More than one canonical frontier output!`);
      // }

      // return { minWeight };
    });
  }

  public isCanonical(fact: BlockFact, cache = this.getCache()) {
    const { canonicality, usurper } = this.getCanonicality(fact, cache);
    if ((canonicality >= 0n) !== (usurper === undefined)) {
      throw new Error(`Invalid response!`);
    }
    return canonicality >= 0n;
  }

  public getCanonicality(fact: BlockFact, cache = this.getCache()) {
    return mapPut(cache.canonicality, fact, () => {
      // return this.getSelfWeight(fact, cache).min +
      //   this.getDescendant(fact, cache).weight +
      //   this.getSelfOffset(fact, cache).min +
      //   this.getAncestorOffset(fact, cache);

      // const selfWeight = this.getSelfWeight(fact, cache).min;
      // const descWeight = this.getDescendant(fact, cache).weight;
      let canonicality = this.getClaimCanonicality(fact, undefined, cache);

      // TODO: Re-add minimization by this.ctx.config.getWeightLimit()

      const parent = this.ctx.get(BlockService).get(fact.frontierVote, false);
      if (parent !== undefined) {
        const parentCanonicality = this.getCanonicality(parent, cache);
        if (parentCanonicality.canonicality < canonicality.canonicality) {
          canonicality = parentCanonicality;
        }
      }

      for (const ref of fact.refs) {
        const parent = this.ctx.get(BlockService).get(ref, false);
        if (parent !== undefined) {
          const parentCanonicality = this.getCanonicality(parent, cache);
          if (parentCanonicality.canonicality < canonicality.canonicality) {
            canonicality = parentCanonicality;
          }
        }
      }

      for (const input of fact.inputs) {
        const parent = this.ctx.get(BlockService).get(input.blockHash, false);
        if (parent !== undefined) {
          const parentCanonicality = this.getCanonicality(parent, cache);
          if (parentCanonicality.canonicality < canonicality.canonicality) {
            canonicality = parentCanonicality;
          }
        }
      }

      return canonicality;
    });
  }

  public getClaimCanonicality(
    fact: BlockFact,
    assume?: BlockFact,
    cache = this.getCache(),
  ) {
    const fn = () => {
      let canonicality = 0n;
      let usurper: OutputClaim | undefined;

      for (const input of fact.inputs) {
        const claims = this.ctx.get(BlockService).getClaims(input);
        if (claims.length === 1) {
          continue;
        }

        if (assume !== undefined) {
          const ancestorClaim = claims.find((x) =>
            this.ctx.get(FrontierChainService).isAncestor(x.block, assume)
          );
          if (ancestorClaim !== undefined) {
            if (ancestorClaim.block === fact) {
              throw new Error(`Assume must not be an ancestor of fact!`);
            } else {
              console.warn(`Merged a double-spend!`);
              if (-1n < canonicality) {
                canonicality = -1n;
              }
              continue;
            }
          }
        }

        const minWeight = claims
          .map((x) => this.getSelfWeight(x.block, cache).min)
          .reduce((x, y) => x < y ? x : y);

        const scores = claims.map((x) =>
          this.getDescendant(x.block, cache).weight -
          this.ctx.config.getOverpaymentPenalty(
            this.getSelfWeight(x.block, cache).max - minWeight,
          )
        );
        const maxScore = scores.reduce((x, y) => x > y ? x : y);
        const maxIdx = scores.indexOf(maxScore);
        // Increment the first occurrence of the maximum score so there's no ties.
        scores[maxIdx]++;
        const selfScore = scores[claims.findIndex((x) => x.block === fact)];
        const claimCanonicality = selfScore - maxScore - 1n;
        if (claimCanonicality < canonicality) {
          canonicality = claimCanonicality;
          usurper = claims[maxIdx];
        }
      }

      return { canonicality, usurper };
    };

    return assume !== undefined
      ? mapPut(cache.claimCanonicality, fact, fn)
      : fn();
  }

  public getTreeChildrenWeight(fact: BlockFact, cache = this.getCache()) {
    return mapPut(cache.treeChildrenWeight, fact, () => {
      const storedWeight = fact.frontierDetail.treeWeights
        .reduce((acc, cur) => acc + cur, 0n);
      if (useTreeWeightForChildren) {
        return storedWeight;
      }

      let weight = 0n;

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (
          block !== undefined && input.outputIdx === block.frontierOutputIdx
        ) {
          weight += this.getSelfWeight(block, cache).min;
          weight += this.getTreeChildrenWeight(block, cache);
        }
      }

      if (weight !== storedWeight) {
        throw new Error(`Computed weight is not equal to the stored weight!`);
      }

      return weight;
    });
  }

  private getTreeChildrenOffset(fact: BlockFact, cache = this.getCache()) {
    return mapPut(cache.treeChildrenOffset, fact, () => {
      let weight = 0n;

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (
          block !== undefined && input.outputIdx === block.frontierOutputIdx
        ) {
          weight += this.getSelfOffset(block, cache).min;
          weight += this.getTreeChildrenOffset(block, cache);
        }
      }

      return weight;
    });
  }

  public getTopParent(fact: BlockFact, cache = this.getCache()): BlockFact {
    const { parent } = this.getDescendant(fact, cache);
    if (parent !== undefined) {
      return this.getTopParent(parent, cache);
    } else {
      return fact;
    }
  }

  /**
   * Returns an array of weights, one for each block in fact's frontier vote chain.
   * - result[0] is the weight of blocks in the tree voting for fact.frontierVote
   * - result[1] is the weight of blocks in the tree voting for fact.frontierVote.frontierVote
   * - result[x] is the weight of blocks in the tree voting for fact.frontierVote.[...].frontierVote
   */
  public getVoterWeight(fact: BlockFact, cache = this.getCache()) {
    return mapPut(cache.voterWeight, fact, () => {
      const desc = this.getDescendant(fact, cache);

      const res = [...fact.frontierDetail.treeWeights];
      for (const voter of desc.voters) {
        const sub = this.getVoterWeight(voter, cache);
        for (let i = 0; i < sub.length; i++) {
          const dst = i ? i - 1 : 0;
          res[dst] ??= 0n;
          res[dst] += sub[i];
        }
      }

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
