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
  selfWeight: Map<BlockFact, { min: bigint; max: bigint }>;
  selfOffset: Map<BlockFact, { min: bigint; max: bigint }>;
  ancestorWeight: Map<BlockFact, { minWeight: bigint }>;
  ancestorOffset: Map<BlockFact, bigint>;
  descendant: Map<
    BlockFact,
    { block?: BlockFact; weight: bigint; isParent: boolean }
  >;
  canonicality: Map<BlockFact, bigint>;
  canonicalVoter: Map<BlockFact | typeof ZERO_BLOCK, BlockFact | undefined>;
  canonicalParent: Map<BlockFact, BlockFact | undefined>;
  claimDelta: Map<BlockFact, bigint>;
  treeChildrenWeight: Map<BlockFact, bigint>;
  treeChildrenOffset: Map<BlockFact, bigint>;
  voterWeight: Map<BlockFact, bigint[]>;
}

export class WeightService {
  constructor(private ctx: Context) {}

  public makeCache(): Cache {
    return {
      selfWeight: new Map(),
      selfOffset: new Map(),
      ancestorWeight: new Map(),
      ancestorOffset: new Map(),
      descendant: new Map(),
      canonicality: new Map(),
      canonicalVoter: new Map(),
      canonicalParent: new Map(),
      claimDelta: new Map(),
      treeChildrenWeight: new Map(),
      treeChildrenOffset: new Map(),
      voterWeight: new Map(),
    };
  }

  public getSelfWeight(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.selfWeight, fact, () => {
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

      let min = BASE_WORK;
      let max = BASE_WORK;

      const factAgeMs = this.ctx.config.timeProvider.now() - fact.receivedAt;
      const workLimit = this.ctx.config.getWeightLimit(factAgeMs);
      if (min > workLimit) {
        min = workLimit;
      }
      if (max > workLimit) {
        max = workLimit;
      }

      // const minWeight = bigintMax(
      //   0n,
      //   BASE_WORK + inputFreeMarketSum - outputCharitySum,
      // );
      // const maxWeight = bigintMax(
      //   0n,
      //   BASE_WORK + inputFreeMarketSum + outputSum - inputKnownSum -
      //     outputCharitySum,
      // );

      return { min, max };
    });
  }

  public getSelfOffset(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.selfOffset, fact, () => {
      let minSiblingWeight = this.getSelfWeight(fact, cache).max;

      let minRecvTime = Infinity;
      if (
        fact.frontierVoteBlock !== undefined &&
        fact.frontierVoteBlock.receivedAt < minRecvTime
      ) {
        minRecvTime = fact.frontierVoteBlock.receivedAt;
      }

      const voters = this.ctx.get(BlockService).getVoters(fact.frontierVote);
      for (const voter of voters) {
        if (voter.receivedAt < minRecvTime) {
          minRecvTime = voter.receivedAt;
        }

        const siblingWeight = this.getSelfWeight(voter, cache).max;
        if (siblingWeight < minSiblingWeight) {
          minSiblingWeight = siblingWeight;
        }
      }

      if (minRecvTime === Infinity) {
        throw new Error(`No voters for frontier vote!`);
      }

      const workLimit = this.ctx.config.getWeightLimit(
        this.ctx.config.timeProvider.now() - minRecvTime,
      );
      if (workLimit < minSiblingWeight) {
        minSiblingWeight = workLimit;
      }

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

      const min = minSiblingWeight - this.getSelfWeight(fact, cache).max;
      const max = min;

      return { min, max };
    });
  }

  public getAncestorWeight(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.ancestorWeight, fact, () => {
      let minWeight = 0n;

      const block = this.ctx.get(BlockService).get(fact.frontierVote, false);
      if (block !== undefined) {
        minWeight += this.getSelfWeight(block, cache).min;
        minWeight += this.getAncestorWeight(block, cache).minWeight;
      }

      minWeight += this.getTreeChildrenWeight(fact, cache);

      return { minWeight };
    });
  }

  public getAncestorOffset(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.ancestorOffset, fact, () => {
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

  public getDescendant(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.descendant, fact, () => {
      let bestScore = 0n;
      let bestDescendant: BlockFact | undefined;
      let bestDescendantWeight = 0n;
      let isParent = false;

      for (const claim of fact.outputClaims[fact.frontierOutputIdx]) {
        const { score, weight } = this.getParentScore(fact, claim.block, cache);
        if (bestDescendant === undefined || score > bestScore) {
          bestScore = score;
          bestDescendant = claim.block;
          bestDescendantWeight = weight;
          isParent = true;
        }
      }

      for (const voter of fact.frontierVoters) {
        const { score, weight } = this.getVoterScore(fact, voter, cache);
        if (
          score !== undefined &&
          (bestDescendant === undefined || score > bestScore)
        ) {
          bestScore = score;
          bestDescendant = voter;
          bestDescendantWeight = weight;
          isParent = false;
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
      //     minWeight += this.getVoterWeight(bestVoter, cache)[0] ?? 0n;
      //   }
      // } else if (count > 1) {
      //   throw new Error(`More than one canonical frontier output!`);
      // }

      // return { minWeight };
    });
  }

  private getParentScore(
    child: BlockFact,
    parent: BlockFact,
    cache = this.makeCache(),
  ) {
    const factChain = this.ctx.get(FrontierChainService)
      .getFrontierChain(child);

    const selfWeight = this.getSelfWeight(parent, cache).min;
    const descWeight = this.getDescendant(parent, cache).weight;
    let coneWeight = 0n;
    let siblingWeight = 0n;
    for (const sibling of parent.inputs) {
      const siblingBlock = this.ctx.get(BlockService)
        .get(sibling.blockHash, false);
      if (
        siblingBlock !== undefined && siblingBlock !== child &&
        siblingBlock.frontierOutputIdx === sibling.outputIdx
      ) {
        let ptr = siblingBlock;
        while (!factChain.has(ptr)) {
          coneWeight += this.getSelfWeight(ptr, cache).min;
          coneWeight += ptr.frontierDetail.treeWeights
            .reduce((acc, cur) => acc + cur, 0n);
          ptr = ptr.frontierVoteBlock ?? error(`Unlinked sibling votes!`);
        }

        if (siblingBlock.frontierVoteBlock === child) {
          siblingWeight += this.getSelfWeight(siblingBlock, cache).min;
          siblingWeight += this.getVoterWeight(siblingBlock, cache)[0] ??
            0n;
        }
      }
    }

    // const score = descWeight - selfWeight - coneWeight;
    const weight = selfWeight + descWeight + siblingWeight;
    const score = weight +
      this.getSelfOffset(parent, cache).min +
      this.getAncestorOffset(parent, cache);

    return { score, weight };
  }

  private getVoterScore(
    child: BlockFact,
    voter: BlockFact,
    cache = this.makeCache(),
  ) {
    const desc = this.getDescendant(voter, cache);
    if (!desc.isParent) {
      const selfWeight = this.getSelfWeight(voter, cache).min;
      const voterWeight = this.getVoterWeight(voter, cache)[0] ?? 0n;

      // const score = desc.weight - selfWeight + voterWeight;
      const weight = selfWeight + desc.weight + voterWeight;
      const score = weight +
        this.getSelfOffset(voter, cache).min +
        this.getAncestorOffset(voter, cache);

      return { score, weight };
    } else {
      return {};
    }
  }

  public isCanonical(fact: BlockFact, cache = this.makeCache()) {
    return this.getCanonicality(fact, cache) >= 0n;
  }

  public getCanonicality(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.canonicality, fact, () => {
      return this.getSelfWeight(fact, cache).min +
        this.getDescendant(fact, cache).weight +
        this.getSelfOffset(fact, cache).min +
        this.getAncestorOffset(fact, cache);

      // const selfWeight = this.getSelfWeight(fact, cache).min;
      // const descWeight = this.getDescendant(fact, cache).weight;
      // let canonicality = selfWeight + descWeight;

      // const parent = this.ctx.get(BlockService).get(fact.frontierVote, false);
      // if (parent !== undefined) {
      //   const parentCanonicality = this.getCanonicality(parent, cache);
      //   if (parentCanonicality < canonicality) {
      //     canonicality = parentCanonicality;
      //   }
      // }

      // for (const input of fact.inputs) {
      //   const parent = this.ctx.get(BlockService).get(input.blockHash, false);
      //   if (
      //     parent !== undefined && parent.frontierOutputIdx === input.outputIdx
      //   ) {
      //     const parentCanonicality = this.getCanonicality(parent, cache);
      //     if (parentCanonicality < canonicality) {
      //       canonicality = parentCanonicality;
      //     }
      //   }
      // }

      // return canonicality;

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
          this.getSelfWeight(voter, cache).min;
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
      const mySelfWeight = this.getSelfWeight(fact, cache).max;
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
              this.getSelfWeight(claim.block, cache).max - mySelfWeight;
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

      return weight;
    });
  }

  private getTreeChildrenOffset(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.treeChildrenOffset, fact, () => {
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

  /**
   * Returns an array of weights, one for each block in the ancestor frontier vote chain.
   * result[0] is the weight of blocks in the tree voting for frontierVote.
   * result[1] is the weight of blocks in the tree voting for frontierVote.frontierVote.
   */
  public getVoterWeight(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.voterWeight, fact, () => {
      const desc = this.getDescendant(fact, cache);

      if (desc.block === undefined || desc.isParent) {
        return fact.frontierDetail.treeWeights;
      }

      const subWeight = this.getVoterWeight(desc.block, cache);

      const res: bigint[] = [];
      for (let i = 0; true; i++) {
        const selfEl = fact.frontierDetail.treeWeights[i];
        const subEl = subWeight[i + 1];
        if (selfEl !== undefined) {
          if (subEl !== undefined) {
            res.push(selfEl + subEl);
          } else {
            res.push(selfEl);
          }
        } else {
          if (subEl !== undefined) {
            res.push(subEl);
          } else {
            break;
          }
        }
      }

      // if (res.length === 0) {
      //   res.push(0n);
      // }
      // res[0] += subWeight[0];

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
