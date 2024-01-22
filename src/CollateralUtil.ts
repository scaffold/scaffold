import { CollateralContractDetail } from './collateralMessages.ts';
import { mapPop, mapPut } from './util/map.ts';
import { AccountContractParams, BlockOutput } from './messages.ts';
import { bin2hex, hex2bin } from './util/hex.ts';
import { accountHash, burnHash } from './constants.ts';
import { EMPTY_ARR } from './util/buffer.ts';
import { error } from './util/functional.ts';
import { bigintMax, bigintMin } from './util/bigint.ts';

export const challengeThreshold = 10n;
export const finalVoteAmount = 100n;
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

  vf0_hintB [label="FinalFail [vf0, hintB]"];
  vf0_hintB -> vf0;
}
*/

// How to incentivize rectification for verifier V?
//   - Output to V, which forces a new block to be created.
//     But this doesn't incentivize the new block to be used.
//   + Blocks derived from an invalid block have a penalty equal to the rectification amount. But if it's too far back, and all available blocks have the same penalty, it doesn't really do anything. If a new chain is created that doesn't include the invalid block, it will likely be chosen.
//     This is also nice because it penalizes building on an invalid block - not a lot, but your work is at risk of being discarded. So make sure you trust ancestors.

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

  public static applyBelief(contest: Contest, vote: DetailVote) {
    const newType = this.getContestType(vote);
    const oldResult = contest.resultWinner;
    if (newType !== contest.typeWinner) {
      contest.typeWinner = newType;
      contest.resultWinner = undefined;
    }

    switch (vote) {
      case 'VALID_CHALLENGE':
        contest.resultWinner = true;
        break;
      case 'ALL_VALID_CONTEST':
        break;
      case 'INVALID_CHALLENGE':
        contest.resultWinner = false;
        break;
      case 'ONE_VALID_CONTEST':
        break;
      case 'FINAL_PASS':
        contest.resultWinner = true;
        break;
      case 'FINAL_FAIL':
        contest.resultWinner = false;
        break;
      case 'FINAL_CONTEST':
        break;
    }

    if (contest.resultWinner !== oldResult) {
      // Recompute parents
      let parent = contest.parent;
      while (parent !== undefined && parent.resultWinner !== undefined) {
        parent.resultWinner = undefined;
        parent = parent.parent;
      }
    }
  }

  public static applyAllBeliefs(
    descriptor: CollateralDescriptor,
    evaluator: (hints: Uint8Array[]) => DetailVote | undefined,
    rectifier?: (hints: Uint8Array[], vote: DetailVote, amount: bigint) => void,
  ) {
    const apply = (contest: Contest, hints: Uint8Array[]) => {
      const vote = evaluator(hints);
      if (vote !== undefined) {
        // It's hacky doing this twice, but we need to do it here to have the parent contest type for children determining their threshold
        this.applyBelief(contest, vote);
      }

      for (const [key, child] of contest.children) {
        hints.push(hex2bin(key));
        apply(child, hints);
        hints.pop();
      }

      if (vote !== undefined) {
        this.applyBelief(contest, vote);

        if (rectifier) {
          let amount = 0n;

          const { ctWinAmt, ctLossAmt, resultWinAmt, resultLossAmt } = this
            .getContestAmounts(contest);
          amount = bigintMax(amount, (ctLossAmt << 1n) - ctWinAmt);

          if (!vote.endsWith('_CONTEST')) {
            let threshold: bigint;
            switch (vote) {
              case 'VALID_CHALLENGE':
                threshold = 0n;
                break;
              case 'INVALID_CHALLENGE':
                threshold = challengeThreshold;
                break;
              case 'FINAL_PASS':
                threshold = contest.parent === undefined ||
                    this.getContestTypeWinner(contest.parent) === true
                  ? finalVoteAmount
                  : 0n;
                break;
              case 'FINAL_FAIL':
                threshold = contest.parent === undefined ||
                    this.getContestTypeWinner(contest.parent) === false
                  ? finalVoteAmount
                  : 0n;
                break;
              default:
                throw new Error(`Internal error`);
            }
            amount = bigintMax(
              amount,
              bigintMax(threshold, resultLossAmt << 1n) - resultWinAmt,
            );
          }

          if (amount > 0n) {
            rectifier(hints, vote, amount);
          }
        }
      }
    };

    apply(descriptor.root, []);
  }

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

  private static getContestAmounts(contest: Contest) {
    let ctWinAmt: bigint;
    let resultWinAmt: bigint;
    let resultLossAmt: bigint;
    switch (this.getContestTypeWinner(contest)) {
      case false:
        ctWinAmt = contest.validChallenge + contest.allValidContest;
        resultWinAmt = this.getResultWinner(contest)
          ? contest.validChallenge
          : 0n;
        resultLossAmt = this.getResultWinner(contest)
          ? 0n
          : contest.validChallenge;
        break;
      case true:
        ctWinAmt = contest.oneValidContest + contest.invalidChallenge;
        resultWinAmt = this.getResultWinner(contest)
          ? 0n
          : contest.invalidChallenge;
        resultLossAmt = this.getResultWinner(contest)
          ? contest.invalidChallenge
          : 0n;
        break;
      case CONTEST_TYPE_FINAL:
        ctWinAmt = contest.finalPass + contest.finalFail + contest.finalContest;
        resultWinAmt = this.getResultWinner(contest)
          ? contest.finalPass
          : contest.finalFail;
        resultLossAmt = this.getResultWinner(contest)
          ? contest.finalFail
          : contest.finalPass;
        break;
    }

    const totalAmt = contest.validChallenge + contest.allValidContest +
      contest.oneValidContest + contest.invalidChallenge +
      contest.finalPass + contest.finalFail + contest.finalContest;

    const ctLossAmt = totalAmt - ctWinAmt;

    return { totalAmt, ctWinAmt, ctLossAmt, resultWinAmt, resultLossAmt };
  }

  public static getOutputMap(descriptor: CollateralDescriptor) {
    // Foreach contest:
    //   Distribute contest type collateralizations to correct postings
    //   Distribute correct contest type but incorrect result collateralizations to correct postings (only applies to final postings)
    // Foreach posting, in order:
    //   If it's correct, then while we have incorrect parents, suck their collateral, recursively iterating parents until we get a correct one.

    const outputKeys = new Map<string, BlockOutput>();
    const addOutput = (dst: Uint8Array, amount: bigint) => {
      if (dst.byteLength === 0) {
        throw new Error(`Empty output dst!`);
      }
      if (amount > 0n) {
        mapPut(outputKeys, bin2hex(dst), () => ({
          verifier: {
            contract_hash: accountHash,
            params: AccountContractParams.encode({ publicKey: dst }),
          },
          amount,
          detail: EMPTY_ARR,
        }), (output) => {
          output.amount += amount;
          return output;
        });
      }
    };
    const addBurn = (amount: bigint) => {
      if (amount > 0n) {
        mapPut(outputKeys, '', () => ({
          verifier: { contract_hash: burnHash, params: EMPTY_ARR },
          amount,
          detail: EMPTY_ARR,
        }), (output) => {
          output.amount += amount;
          return output;
        });
      }
    };

    const remainingRewards = new Map<Contest, bigint>();

    const distributeContest = (contest: Contest) => {
      const { ctLossAmt, resultLossAmt } = this.getContestAmounts(contest);

      let remainingCtReward = ctLossAmt;
      let remainingResultReward = resultLossAmt;
      for (const posting of contest.postings) {
        if (this.didWinContestType(posting.detail.vote, contest)) {
          const eligibleReward = posting.amount >> 1n;

          const d = bigintMin(eligibleReward, remainingCtReward);
          let amount = d;
          remainingCtReward -= d;

          const wonResult = this.didWinResult(posting.detail.vote, contest);
          if (wonResult === undefined) {
            amount += posting.amount; // Just get back our posting
          } else if (wonResult) {
            const d = bigintMin(eligibleReward, remainingResultReward);
            amount += posting.amount + d;
            remainingResultReward -= d;
          }

          addOutput(posting.detail.publicKey, amount);
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

        addOutput(posting.detail.publicKey, amount);
      }
    }

    for (const amount of remainingRewards.values()) {
      addBurn(amount);
    }

    return outputKeys;
  }

  public static isValid(descriptor: CollateralDescriptor) {
    return this.getResultWinner(descriptor.root);
  }
}
