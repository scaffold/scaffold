import { Context } from './Context.ts';
import { BlockFact, FactSource } from './FactMeta.ts';
import { ContractClassifierService } from './ContractClassifierService.ts';
import { BASE_WORK, BlockService } from './BlockService.ts';
import { bigintMax } from './util/bigint.ts';
import { Hash } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { ZERO_HASH } from './util/Hash.ts';
import { error, todo } from './util/functional.ts';
import { GenesisService } from './GenesisService.ts';
import { FrontierChainService } from './FrontierChainService.ts';
import { FrontierHelper } from './FrontierHelper.ts';

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

interface DescendantResult {
  parent?: BlockFact;
  voters: BlockFact[];

  leaves: BlockFact[];
  total: bigint;
}

interface Cache {
  selfWeight: Map<BlockFact, { min: bigint; max: bigint }>;
  selfOffset: Map<BlockFact, { min: bigint; max: bigint }>;
  ancestorWeight: Map<BlockFact, bigint>;
  ancestorOffset: Map<BlockFact, bigint>;
  descendant: Map<BlockFact, DescendantResult>;
  orphans: Map<BlockFact, BlockFact[]>;
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
      orphans: new Map(),
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

  public getAncestorWeight(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.ancestorWeight, fact, () => {
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

  /**
   * Returns some properties related to the descendants of the given block:
   * - block: The most canonical immediate descendant (either a parent or frontier voter), or undefined if none
   * - isParent: Whether the returned descendant is a parent, or false if none
   */
  public getDescendant(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.descendant, fact, () => {
      const selfTotal = this.getSelfWeight(fact, cache).min +
        this.getSelfOffset(fact, cache).min +
        this.getAncestorWeight(fact, cache) +
        this.getAncestorOffset(fact, cache);
      let bestResult: DescendantResult = {
        voters: [],
        leaves: [fact],
        total: selfTotal,
      };

      for (const claim of fact.outputClaims[fact.frontierOutputIdx]) {
        const candidate = this.getDescendant(claim.block, cache);
        if (candidate.total > bestResult.total) {
          bestResult = { ...candidate, parent: claim.block, voters: [] };
        }
      }

      const voters = fact.frontierVoters.filter((x) => {
        const candidate = this.getDescendant(x, cache);
        return candidate.parent === undefined &&
          candidate.total > bestResult.total;
      });
      for (const voter of voters) {
        const candidate = this.getDescendant(voter, cache);
        bestResult.voters.push(voter);
        bestResult.leaves.push(...candidate.leaves);
        bestResult.total += candidate.total - selfTotal;
      }

      return bestResult;

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

  private getDescendantWithOrphans(fact: BlockFact, cache = this.makeCache()) {
    let result = this.getDescendant(fact, cache);

    // if (result.leaves.length !== 1) {
    //   throw new Error(`Not exactly one leaf!`);
    // }

    // const orphans = this.getOrphans(result.leaves[0], cache).sort((a, b) =>
    //   Number(
    //     this.getDescendant(b, cache).total -
    //       this.getDescendant(a, cache).total,
    //   )
    // );

    // const canMerge = (inputs: { block: BlockFact }[]) => {
    //   try {
    //     FrontierHelper.mergeTreeIo(
    //       inputs,
    //       ZERO_BLOCK,
    //       (hash) =>
    //         this.ctx.get(BlockService).get(hash, false) ??
    //           error(`Unknown frontier child input!`),
    //     );
    //     return true;
    //   } catch (_err) {
    //     return false;
    //   }
    // };

    // for (const orphan of orphans) {
    //   if (
    //     !this.ctx.get(FrontierChainService).getFrontierChain(result.leaves[0])
    //       .has(this.getTopParent(orphan, cache)) && canMerge([
    //         ...result.leaves.map((x) => ({ block: x })),
    //         { block: orphan },
    //       ])
    //   ) {
    //     result = { ...result, leaves: [...result.leaves, orphan] };

    //     const commonWeight = orphan.frontierVoteBlock !== undefined
    //       ? this.getSelfWeight(orphan.frontierVoteBlock, cache).min +
    //         this.getSelfOffset(orphan.frontierVoteBlock, cache).min +
    //         this.getAncestorWeight(orphan.frontierVoteBlock, cache) +
    //         this.getAncestorOffset(orphan.frontierVoteBlock, cache)
    //       : 0n;
    //     const delta = this.getDescendant(orphan, cache).total - commonWeight;
    //     result = { ...result, total: result.total + delta };
    //   }
    // }

    return result;
  }

  private getOrphans(fact: BlockFact, cache = this.makeCache()): BlockFact[] {
    return getOrCreate(cache.orphans, fact, () => {
      return fact.frontierVoteBlock !== undefined
        ? [
          ...this.getOrphans(fact.frontierVoteBlock, cache),
          ...fact.frontierVoteBlock.frontierVoters.filter((x) => x !== fact),
        ]
        : [];
    });
  }

  public isCanonical(fact: BlockFact, cache = this.makeCache()) {
    return this.getCanonicality(fact, cache) >= 0n;
  }

  public getCanonicality(fact: BlockFact, cache = this.makeCache()) {
    return getOrCreate(cache.canonicality, fact, () => {
      const genesis = this.ctx.get(GenesisService).getGenesisBlock();
      const genesisDesc = this.getDescendant(genesis, cache);
      const factDesc = this.getDescendant(fact, cache);
      return factDesc.leaves.every((x) => genesisDesc.leaves.includes(x))
        ? 0n
        : factDesc.total - genesisDesc.total;

      // return this.getSelfWeight(fact, cache).min +
      //   this.getDescendant(fact, cache).weight +
      //   this.getSelfOffset(fact, cache).min +
      //   this.getAncestorOffset(fact, cache);

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

      const storedWeight = fact.frontierDetail.treeWeights
        .reduce((acc, cur) => acc + cur, 0n);
      if (weight !== storedWeight) {
        throw new Error(`Computed weight is not equal to the stored weight!`);
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

  public getTopParent(fact: BlockFact, cache = this.makeCache()): BlockFact {
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
  public getVoterWeight(fact: BlockFact, cache = this.makeCache()) {
    todo();

    return getOrCreate(cache.voterWeight, fact, () => {
      const desc = this.getDescendant(fact, cache);

      if (desc.voters.length === 0) {
        return fact.frontierDetail.treeWeights;
      }

      // TODO: Handle other voters
      const subWeight = this.getVoterWeight(desc.voters[0], cache);

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
