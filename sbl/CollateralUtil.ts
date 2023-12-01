import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';
import { mapPop, mapPut } from '~/sbl/util/map.ts';
import { AccountContractParams, BlockOutput } from '~/sbl/messages.ts';
import { bin2hex } from '~/sbl/util/hex.ts';
import { accountHash, burnHash } from '~/sbl/constants.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { error } from '~/sbl/util/functional.ts';

export const challengeThreshold = 10n;

/*
https://edotor.net/
digraph G {
    rankdir="RL";

  root [label="AllColl []"];

  hash0 [label="OneColl [hash0]"];
  hash0 -> root;

  hash0_textA [label="FinalPass [hash0, textA]"];
  hash0_textA -> hash0;

  hash0_textB [label="FinalFail [hash0, textB]"];
  hash0_textB -> hash0;

  vf0 [label="AllContest [vf0]"];
  vf0 -> root;

  vf0_hintA [label="FinalPass [vf0, hintA]"];
  vf0_hintA -> vf0;

  vf1_hintA [label="FinalFail [vf1, hintA]"];
  vf1_hintA -> vf0;
}
*/

export const CONTEST_TYPE_FINAL = Symbol('CollateralUtil.ContestTypeFinal');
export interface Posting {
  detail: CollateralContractDetail;
  amount: bigint;
}
export interface Contest {
  postings: Posting[];

  parent?: Contest;
  children: Map<string, Contest>;

  validChallenge: bigint;
  allValidContest: bigint;
  invalidChallenge: bigint;
  oneValidContest: bigint;
  finalPass: bigint;
  finalFail: bigint;
  finalContest: bigint;

  typeWinner?: boolean | typeof CONTEST_TYPE_FINAL;
  resultWinner?: boolean;
  paymentSrcs?: Posting[];
}
export interface CollateralDescriptor {
  postings: Iterable<Posting>;
  root: Contest;
  contestMap: Map<Posting, Contest>;
}
export type DetailVote = CollateralContractDetail['vote'];

export default class CollateralUtil {
  private static makeContest(parent?: Contest): Contest {
    return {
      postings: [],

      parent,
      children: new Map(),

      validChallenge: 0n,
      allValidContest: 0n,
      invalidChallenge: 0n,
      oneValidContest: 0n,
      finalPass: 0n,
      finalFail: 0n,
      finalContest: 0n,
    };
  }

  public static buildTree(postings: Iterable<Posting>): CollateralDescriptor {
    const root: Contest = this.makeContest();
    const contestMap = new Map<Posting, Contest>();
    for (const posting of postings) {
      let ptr = root;
      for (const hint of posting.detail.hints) {
        ptr = mapPut(ptr.children, bin2hex(hint), () => this.makeContest(ptr));
      }
      ptr.postings.push(posting);

      switch (posting.detail.vote) {
        case 'VALID_CHALLENGE':
          ptr.validChallenge += posting.amount;
          break;
        case 'ALL_VALID_CONTEST':
          ptr.allValidContest += posting.amount;
          break;
        case 'INVALID_CHALLENGE':
          ptr.invalidChallenge += posting.amount;
          break;
        case 'ONE_VALID_CONTEST':
          ptr.oneValidContest += posting.amount;
          break;
        case 'FINAL_PASS':
          ptr.finalPass += posting.amount;
          break;
        case 'FINAL_FAIL':
          ptr.finalFail += posting.amount;
          break;
        case 'FINAL_CONTEST':
          ptr.finalContest += posting.amount;
          break;
      }

      mapPut(contestMap, posting, () => ptr, () => {
        throw new Error(`Duplicate postings!`);
      });
    }
    return { postings, root, contestMap };
  }

  private static getContestTypeWinner(contest: Contest) {
    if (contest.typeWinner === undefined) {
      const allValidSum = contest.validChallenge + contest.allValidContest;
      const oneValidSum = contest.oneValidContest + contest.invalidChallenge;
      const finalSum = contest.finalPass + contest.finalFail +
        contest.finalContest;

      if (allValidSum >= oneValidSum) {
        if (allValidSum >= finalSum) {
          contest.typeWinner = false;
        } else {
          contest.typeWinner = CONTEST_TYPE_FINAL;
        }
      } else {
        if (oneValidSum >= finalSum) {
          contest.typeWinner = true;
        } else {
          contest.typeWinner = CONTEST_TYPE_FINAL;
        }
      }
    }
    return contest.typeWinner;
  }

  private static getResultWinner(contest: Contest): boolean {
    if (contest.resultWinner === undefined) {
      const type = this.getContestTypeWinner(contest);
      if (type === CONTEST_TYPE_FINAL) {
        // Here, payments come from the final votes of the other side
        contest.resultWinner = contest.finalPass >= contest.finalFail;
      } else {
        for (const child of contest.children.values()) {
          const childResult = this.getResultWinner(child);
          if (childResult === type) {
            // If valid (true), payments go to the child and come from INVALID_CHALLENGE votes
            // If invalid (false), payments go to the child and come from VALID_CHALLENGE votes
            contest.resultWinner = type;
            break;
          }
        }

        if (contest.resultWinner === undefined) {
          // If the type is valid (true), payments come from INVALID_CHALLENGE if lt the threshold, or [] if gte
          // If the type is invalid (false), payments are []
          contest.resultWinner = type
            ? contest.invalidChallenge < challengeThreshold
            : true;
        }
      }
    }
    return contest.resultWinner;
  }

  // private static getPayments(
  //   contest: Contest,
  // ): { paymentSrcs: Posting[]; paymentDsts: Posting[] } {
  //   if (
  //     contest.paymentSrcs === undefined || contest.paymentDsts === undefined
  //   ) {
  //     const type = this.getContestTypeWinner(contest);
  //     if (type === CONTEST_TYPE_FINAL) {
  //       const winner = contest.finalPass >= contest.finalFail;
  //       const passes = contest.postings.filter((x) =>
  //         x.detail.vote === 'FINAL_PASS'
  //       );
  //       const fails = contest.postings.filter((x) =>
  //         x.detail.vote === 'FINAL_FAIL'
  //       );
  //       contest.paymentSrcs = winner ? fails : passes;
  //       contest.paymentDsts = winner ? passes : fails;
  //     } else {
  //       for (const child of contest.children.values()) {
  //         const childResult = this.getResultWinner(child);
  //         if (childResult === type) {
  //           const childPayments = this.getPayments(child);
  //           childPayments;
  //           contest.resultWhy = type;
  //           break;
  //         }
  //       }

  //       if (contest.resultWhy === undefined) {
  //         // Here, we just need to cross a threshold
  //         contest.resultWhy = type
  //           ? contest.invalidChallenge < challengeThreshold
  //           : true;
  //       }
  //     }
  //   }
  //   return contest;
  // }

  public static getContestType(vote: DetailVote) {
    switch (vote) {
      case 'VALID_CHALLENGE':
        return false;
      case 'ALL_VALID_CONTEST':
        return false;
      case 'INVALID_CHALLENGE':
        return true;
      case 'ONE_VALID_CONTEST':
        return true;
      case 'FINAL_PASS':
        return CONTEST_TYPE_FINAL;
      case 'FINAL_FAIL':
        return CONTEST_TYPE_FINAL;
      case 'FINAL_CONTEST':
        return CONTEST_TYPE_FINAL;
    }
  }

  private static didWinContestType(vote: DetailVote, contest: Contest) {
    return this.getContestTypeWinner(contest) === this.getContestType(vote);
  }

  private static didWinResult(vote: DetailVote, contest: Contest) {
    const result = this.getResultWinner(contest);
    switch (vote) {
      case 'VALID_CHALLENGE':
        return result === true;
      case 'ALL_VALID_CONTEST':
        return undefined;
      case 'INVALID_CHALLENGE':
        return result === false;
      case 'ONE_VALID_CONTEST':
        return undefined;
      case 'FINAL_PASS':
        return result === true;
      case 'FINAL_FAIL':
        return result === false;
      case 'FINAL_CONTEST':
        return undefined;
    }
  }

  public static getOutputMap(descriptor: CollateralDescriptor) {
    // Foreach contest:
    //   Distribute contest type collateralizations to correct postings
    //   Distribute correct contest type but incorrect result collateralizations to correct postings (just final postings)
    // Foreach posting, in order:
    //   If it's correct, then while we have incorrect parents, suck their collateral, recursively iterating parents until we get a correct one.

    const outputKeys = new Map<string, BlockOutput>();
    const addOutput = (dst: Uint8Array, amount: bigint) =>
      amount > 0n &&
      mapPut(outputKeys, bin2hex(dst), () => ({
        verifier: {
          contract_hash: accountHash,
          params: AccountContractParams.encode({ public_key: dst }),
        },
        amount,
        detail: EMPTY_ARR,
      }), (output) => {
        output.amount += amount;
        return output;
      });
    const addBurn = (amount: bigint) =>
      amount > 0n &&
      mapPut(
        outputKeys,
        'x',
        () => ({
          verifier: { contract_hash: burnHash, params: EMPTY_ARR },
          amount,
          detail: EMPTY_ARR,
        }),
        (output) => {
          output.amount += amount;
          return output;
        },
      ) && console.log(`Burning ${amount}`);

    const remainingRewards = new Map<Contest, bigint>();

    const distributeContest = (contest: Contest) => {
      let ctWinAmt: bigint;
      let remainingResultReward: bigint;
      switch (this.getContestTypeWinner(contest)) {
        case false:
          ctWinAmt = contest.validChallenge + contest.allValidContest;
          remainingResultReward = this.getResultWinner(contest)
            ? 0n
            : contest.validChallenge;
          break;
        case true:
          ctWinAmt = contest.oneValidContest + contest.invalidChallenge;
          remainingResultReward = this.getResultWinner(contest)
            ? contest.invalidChallenge
            : 0n;
          break;
        case CONTEST_TYPE_FINAL:
          ctWinAmt = contest.finalPass + contest.finalFail +
            contest.finalContest;
          remainingResultReward = this.getResultWinner(contest)
            ? contest.finalFail
            : contest.finalPass;
          break;
      }

      const totalAmt = contest.validChallenge + contest.allValidContest +
        contest.oneValidContest + contest.invalidChallenge +
        contest.finalPass + contest.finalFail + contest.finalContest;

      let remainingCtReward = totalAmt - ctWinAmt;
      for (const posting of contest.postings) {
        if (this.didWinContestType(posting.detail.vote, contest)) {
          const d = posting.amount < remainingCtReward
            ? posting.amount
            : remainingCtReward;

          let amount = d;
          remainingCtReward -= d;

          const wonResult = this.didWinResult(posting.detail.vote, contest);
          if (wonResult === undefined) {
            amount += posting.amount; // Just get back our posting
          } else if (wonResult) {
            const d = posting.amount < remainingResultReward
              ? posting.amount
              : remainingResultReward;

            amount += posting.amount + d;
            remainingResultReward -= d;
          }

          addOutput(posting.detail.public_key, amount);
        }
      }

      addBurn(remainingCtReward);

      if (remainingResultReward > 0n) {
        mapPut(
          remainingRewards,
          contest,
          () => remainingResultReward,
          () => error(`Duplicate contests!`),
        );
      }

      for (const child of contest.children.values()) {
        distributeContest(child);
      }
    };

    distributeContest(descriptor.root);

    for (const posting of descriptor.postings) {
      const contest = descriptor.contestMap.get(posting) ??
        error(`Posting doesn't have a contest!`);

      // Note: Solely contestType votes, when this.didWinResult returns undefined, aren't elegible for parent collateral
      if (
        this.didWinContestType(posting.detail.vote, contest) &&
        this.didWinResult(posting.detail.vote, contest)
      ) {
        let amount = 0n;

        const requireContestType = this.getResultWinner(contest);
        let parent = contest.parent;
        while (
          parent !== undefined &&
          this.getContestTypeWinner(parent) === requireContestType
        ) {
          amount += mapPop(remainingRewards, parent) ?? 0n;
          parent = parent.parent;
        }

        addOutput(posting.detail.public_key, amount);
      }
    }

    for (const amount of remainingRewards.values()) {
      addBurn(amount);
    }

    return outputKeys;
  }

  public static getOutputMapOld(descriptor: CollateralDescriptor) {
    interface PostingMeta {
      total: bigint;
      rewardFromContestType: bigint;
      rewardFromResult: bigint;
    }
    const postingMeta = new Map<Posting, PostingMeta>();
    const getMeta = (posting: Posting) =>
      mapPut(postingMeta, posting, () => {
        const contest = descriptor.contestMap.get(posting) ??
          error(`Posting doesn't have a contest!`);

        const wonContestType = this.didWinContestType(
          posting.detail.vote,
          contest,
        );
        let rewardFromContestType: bigint;
        let rewardFromResult: bigint;
        if (wonContestType) {
          rewardFromContestType = posting.amount;

          const wonResult = this.didWinResult(posting.detail.vote, contest);
          if (wonResult === undefined) {
            rewardFromResult = 0n;
          } else if (wonResult) {
            // rewardFromResult = 1n << 64n;
            rewardFromResult = 1000000000n;
          } else {
            rewardFromResult = -posting.amount;
          }
        } else {
          rewardFromContestType = -posting.amount;
          rewardFromResult = 0n;
        }
        const total = posting.amount + rewardFromContestType + rewardFromResult;

        return { total, rewardFromContestType, rewardFromResult };
      });

    const distribute = <Key extends string>(
      key: Key,
      a: { [x in Key]: bigint },
      b: { [x in Key]: bigint },
    ) => {
      if (a[key] > 0n) {
        if (b[key] < 0n) {
          if (b[key] > -a[key]) {
            a[key] += b[key];
            b[key] = 0n;
          } else {
            b[key] += a[key];
            a[key] = 0n;
          }
        }
      } else {
        if (b[key] > 0n) {
          if (b[key] > -a[key]) {
            b[key] += a[key];
            a[key] = 0n;
          } else {
            a[key] += b[key];
            b[key] = 0n;
          }
        }
      }
    };

    for (const posting of descriptor.postings) {
      const contest = descriptor.contestMap.get(posting) ??
        error(`Posting doesn't have a contest!`);
      const meta = getMeta(posting);

      if (meta.rewardFromContestType !== 0n) {
        for (const siblingPosting of contest.postings) {
          distribute('rewardFromContestType', meta, getMeta(siblingPosting));
          if (meta.rewardFromContestType === 0n) {
            break;
          }
        }
      }

      distributed_reward: {
        console.log('ABC');
        if (meta.rewardFromResult === 0n) {
          break distributed_reward;
        }

        let parent = contest.parent;
        while (parent !== undefined) {
          for (const parentPosting of parent.postings) {
            console.log(posting.detail.vote, parentPosting.detail.vote);
            console.log(meta, getMeta(parentPosting));
            distribute('rewardFromResult', meta, getMeta(parentPosting));
            console.log(meta, getMeta(parentPosting));
            if (meta.rewardFromResult === 0n) {
              break distributed_reward;
            }
          }
          parent = parent.parent;
        }

        for (const siblingPosting of contest.postings) {
          distribute('rewardFromResult', meta, getMeta(siblingPosting));
          if (meta.rewardFromResult === 0n) {
            break distributed_reward;
          }
        }
      }
    }

    const outputKeys = new Map<string, BlockOutput>();
    const addOutput = (dst: Uint8Array, amount: bigint) =>
      mapPut(outputKeys, bin2hex(dst), () => ({
        verifier: {
          contract_hash: accountHash,
          params: AccountContractParams.encode({ public_key: dst }),
        },
        amount,
        detail: EMPTY_ARR,
      }), (output) => {
        output.amount += amount;
        return output;
      });

    for (const [posting, meta] of postingMeta) {
      const amount = meta.total - meta.rewardFromContestType -
        meta.rewardFromResult;
      if (amount > 0n) {
        addOutput(posting.detail.public_key, amount);
      } else if (amount < 0n) {
        throw new Error(`Negative output!`);
      }
    }

    return outputKeys;
  }

  public static getEqualizingPostings(
    descriptor: CollateralDescriptor,
    publicKey: Uint8Array,
  ) {
  }

  // private static getOutputMapOld(contests: Iterable<Contest>) {
  //   const outputKeys = new Map<string, BlockOutput>();
  //   for (const contest of contests) {
  //     const totalAmt = contest.VALID + contest.INVALID + contest.INCONCLUSIVE;
  //     const winAmt = contest[this.getWinner(contest)];
  //     const lossAmt = totalAmt - winAmt;

  //     const maxWinAmt = lossAmt << 1n;
  //     const effectiveWinAmt = winAmt < maxWinAmt ? winAmt : maxWinAmt;

  //     let src = lossAmt;
  //     let dst = effectiveWinAmt;

  //     for (const posting of contest.postings) {
  //       if (posting.detail.result === contest.winner) {
  //         let amount: bigint;
  //         if (dst > 0n) {
  //           const effectiveAmt = dst < posting.amount ? dst : posting.amount;

  //           amount = effectiveAmt * src / dst;
  //           src -= amount;
  //           dst -= effectiveAmt;

  //           amount += posting.amount;
  //         } else {
  //           amount = posting.amount;
  //         }

  //         mapPut(outputKeys, bin2hex(posting.detail.public_key), () => ({  //           verifier: {
  //             contract_hash: accountHash,
  //             params: AccountContractParams.encode({
  //               public_key: posting.detail.public_key,
  //             }),
  //           },
  //           amount,
  //           detail: EMPTY_ARR,
  //         }), (output) => {
  //           output.amount += amount;
  //           return output;
  //         });
  //       }
  //     }

  //     if (src !== 0n || dst !== 0n) {
  //       throw new Error(
  //         `Error distributing collateral: src=${src}; dst=${dst}`,
  //       );
  //     }
  //   }
  //   return outputKeys;
  // }

  public static isValid(descriptor: CollateralDescriptor) {
    return this.getResultWinner(descriptor.root);
  }
}
