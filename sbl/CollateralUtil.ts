import Hash, { EMPTY_HASH, HashPrimitive } from './util/Hash.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import { AccountContractParams, BlockOutput } from '~/sbl/messages.ts';
import { bin2hex } from '~/sbl/util/hex.ts';
import { accountHash } from '~/sbl/constants.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';

const challengeThreshold = 10n;

const CONTEST_TYPE_FINAL = Symbol('CollateralUtil.ContestTypeFinal');
export interface Posting {
  detail: CollateralContractDetail;
  amount: bigint;
}
export interface Contest {
  postings: Posting[];

  parent?: Contest;
  children: Map<string, Contest>;

  invalidationPass: bigint;
  invalidationFail: bigint;
  validationPass: bigint;
  validationFail: bigint;
  finalPass: bigint;
  finalFail: bigint;

  typeWinner?: boolean | typeof CONTEST_TYPE_FINAL;
  resultWinner?: boolean;
}

export default class CollateralUtil {
  private static makeContest(parent?: Contest) {
    return {
      postings: [],

      parent,
      children: new Map(),

      invalidationPass: 0n,
      invalidationFail: 0n,
      validationPass: 0n,
      validationFail: 0n,
      finalPass: 0n,
      finalFail: 0n,
    };
  }

  public static buildTree(postings: Iterable<Posting>) {
    const root: Contest = this.makeContest();
    for (const posting of postings) {
      let ptr = root;
      for (const hint of posting.detail.hints) {
        ptr = getOrCreate(
          ptr.children,
          bin2hex(hint),
          () => this.makeContest(ptr),
        );
      }
      ptr.postings.push(posting);

      switch (posting.detail.contest_type) {
        case 'INVALIDATION':
          if (posting.detail.passed) {
            ptr.invalidationPass += posting.amount;
          } else {
            ptr.invalidationFail += posting.amount;
          }
          break;

        case 'VALIDATION':
          if (posting.detail.passed) {
            ptr.validationPass += posting.amount;
          } else {
            ptr.validationFail += posting.amount;
          }
          break;

        case 'FINAL':
          if (posting.detail.passed) {
            ptr.finalPass += posting.amount;
          } else {
            ptr.finalFail += posting.amount;
          }
          break;
      }
    }
    return root;
  }

  private static getContestTypeWinner(contest: Contest) {
    if (contest.typeWinner === undefined) {
      const invalidationSum = contest.invalidationPass +
        contest.invalidationFail;
      const validationSum = contest.validationPass + contest.validationFail;
      const finalSum = contest.finalPass + contest.finalFail;

      if (invalidationSum > validationSum) {
        if (invalidationSum > finalSum) {
          contest.typeWinner = false;
        } else {
          contest.typeWinner = CONTEST_TYPE_FINAL;
        }
      } else {
        if (validationSum > finalSum) {
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
        // Here, we just need to cross a threshold
        contest.resultWinner = contest.finalPass >= contest.finalFail;
      } else {
        for (const child of contest.children.values()) {
          const childResult = this.getResultWinner(child);
          if (childResult === type) {
            contest.resultWinner = type;
          }
        }

        if (contest.resultWinner === undefined) {
          // Here, we just need to cross a threshold
          contest.resultWinner = type
            ? contest.validationFail >= challengeThreshold
            : contest.invalidationPass >= challengeThreshold;
        }
      }
    }
    return contest.resultWinner;
  }

  private static hashContest(contest: DetailContest) {
    return contest === null
      ? EMPTY_HASH
      : Hash.digest(CollateralContest.encode(contest.CollateralContest));
  }
  private static getParentContest(contest: DetailContest): DetailContest {
    if (contest === null) {
      throw new Error(`No parent!`);
    } else if (contest.CollateralContest.hint === null) {
      return null;
    } else {
      return {
        CollateralContest: {
          target: contest.CollateralContest.target,
          hint: null,
        },
      };
    }
  }

  private static isVoteAllowed(contest: DetailContest, vote: DetailResult) {
    if (contest === null) {
      return ['VALID'].includes(vote);
    } else if (
      'CollateralTargetInputHash' in contest.CollateralContest.target
    ) {
      if (contest.CollateralContest.hint === null) {
        return ['INVALID'].includes(vote);
      } else {
        return ['VALID', 'INCONCLUSIVE'].includes(vote);
      }
    } else if ('CollateralTargetVerifier' in contest.CollateralContest.target) {
      if (contest.CollateralContest.hint === null) {
        return ['VALID', 'INVALID'].includes(vote);
      } else {
        return true;
      }
    }
  }
  private static getChildVoteInfluence(
    parentContest: DetailContest,
    vote: DetailResult,
  ) {
    if (parentContest === null) {
      return vote === 'INVALID';
    } else if (
      'CollateralTargetInputHash' in parentContest.CollateralContest.target
    ) {
      if (parentContest.CollateralContest.hint === null) {
        return vote === 'VALID';
      } else {
        throw new Error('Internal error');
      }
    } else if (
      'CollateralTargetVerifier' in parentContest.CollateralContest.target
    ) {
      if (parentContest.CollateralContest.hint === null) {
        return true;
      } else {
        throw new Error('Internal error');
      }
    }
  }

  private static findContest(
    contests: Map<HashPrimitive, Contest>,
    spec: DetailContest,
  ) {
    const key = this.hashContest(spec).toPrimitive();
    let res = contests.get(key);
    if (res === undefined) {
      res = {
        spec,
        postings: [],
        children: [],
        VALID: 0n,
        INVALID: 0n,
        INCONCLUSIVE: 0n,
      };
      contests.set(key, res);

      if (spec !== null) {
        res.parent = this.findContest(contests, this.getParentContest(spec));
        res.parent.children.push(res);
      }
    }

    return res;
  }

  // NOTE: Postings must be sorted by order of canonicality!
  public static getContests(postings: Iterable<Posting>) {
    const contests = new Map<HashPrimitive, Contest>();
    for (const posting of postings) {
      const contest = this.findContest(contests, posting.detail.contest);
      contest.postings.push(posting);
      contest[posting.detail.result] += posting.amount;
    }
    return contests;
  }

  public static getWinner(contest: Contest): DetailResult {
    if (contest.winner === undefined) {
      let hasChildValid = false;
      let hasChildInvalid = false;
      for (const child of contest.children) {
        const winner = this.getWinner(child);
        if (winner === 'VALID') {
          hasChildValid = true;
        } else if (winner === 'INVALID') {
          hasChildInvalid = true;
        }
      }

      if (
        hasChildValid && !hasChildInvalid &&
        this.getChildVoteInfluence(contest.spec, 'VALID')
      ) {
        contest.winner = 'VALID';
      } else if (
        hasChildInvalid && !hasChildValid &&
        this.getChildVoteInfluence(contest.spec, 'INVALID')
      ) {
        contest.winner = 'INVALID';
      } else {
        const valid = contest.VALID &&
            this.isVoteAllowed(contest.spec, 'VALID')
          ? contest.VALID
          : 0n;
        const invalid = contest.INVALID &&
            this.isVoteAllowed(contest.spec, 'INVALID')
          ? contest.INVALID
          : 0n;
        const inconclusive = contest.INCONCLUSIVE &&
            this.isVoteAllowed(contest.spec, 'INCONCLUSIVE')
          ? contest.INCONCLUSIVE
          : 0n;

        if (valid >= invalid) {
          if (valid >= inconclusive) {
            contest.winner = 'VALID';
          } else {
            contest.winner = 'INCONCLUSIVE';
          }
        } else {
          if (invalid > inconclusive) {
            contest.winner = 'INVALID';
          } else {
            contest.winner = 'INCONCLUSIVE';
          }
        }
      }
    }

    return contest.winner;
  }

  public static getOutputMap(
    postings: Iterable<Posting>,
    contests: Map<HashPrimitive, Contest>,
  ) {
    const outputKeys = new Map<string, BlockOutput>();
    const addOutput = (dst: Uint8Array, amount: bigint) =>
      getOrCreate(outputKeys, bin2hex(dst), () => ({
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

    for (const posting of postings) {
      const key = this.hashContest(posting.detail.contest).toPrimitive();
      const contest = contests.get(key);
      if (contest === undefined) {
        throw new Error(`No contest for posting!`);
      }

      const isCorrect = posting.detail.result === this.getWinner(contest);
      // Positive, reward, correct: claim an extra x * collateral. first look towards parents, then self, then add onto rewardRemaining
      // Negative, penalty, incorrect:
      let claimTotal: bigint;
      let rewardRemaining: bigint;

      if (isCorrect) {
        claimTotal = posting.amount;
        rewardRemaining = (posting.amount * 1n) >> 0n;
      } else {
        claimTotal = posting.amount;
        rewardRemaining = -(posting.amount * 1n) >> 0n;
      }

      let parent = contest.parent;
      while (parent !== undefined) {
        if (
          rewardRemaining < 0n &&
          parent.rewardRemaining > -rewardRemaining
        ) {
          parent.rewardRemaining += rewardRemaining;
          claimTotal += rewardRemaining;
          rewardRemaining = 0n;
          break;
        } else if (
          parent.rewardRemaining < 0n &&
          rewardRemaining > -parent.rewardRemaining
        ) {
          rewardRemaining += parent.rewardRemaining;
          claimTotal -= parent.rewardRemaining;
          parent.rewardRemaining = 0n;
        }
        parent = parent.parent;
      }

      contest.rewardRemaining += rewardRemaining;

      addOutput(posting.detail.public_key, claimTotal);
    }

    for (const contest of lostContests) {
      addOutput(EMPTY_ARR, contest.lostCoins);
    }

    return outputKeys;
  }

  public static getOutputMapOld(contests: Iterable<Contest>) {
    const outputKeys = new Map<string, BlockOutput>();
    for (const contest of contests) {
      const totalAmt = contest.VALID + contest.INVALID + contest.INCONCLUSIVE;
      const winAmt = contest[this.getWinner(contest)];
      const lossAmt = totalAmt - winAmt;

      const maxWinAmt = lossAmt << 1n;
      const effectiveWinAmt = winAmt < maxWinAmt ? winAmt : maxWinAmt;

      let src = lossAmt;
      let dst = effectiveWinAmt;

      for (const posting of contest.postings) {
        if (posting.detail.result === contest.winner) {
          let amount: bigint;
          if (dst > 0n) {
            const effectiveAmt = dst < posting.amount ? dst : posting.amount;

            amount = effectiveAmt * src / dst;
            src -= amount;
            dst -= effectiveAmt;

            amount += posting.amount;
          } else {
            amount = posting.amount;
          }

          getOrCreate(outputKeys, bin2hex(posting.detail.public_key), () => ({
            verifier: {
              contract_hash: accountHash,
              params: AccountContractParams.encode({
                public_key: posting.detail.public_key,
              }),
            },
            amount,
            detail: EMPTY_ARR,
          }), (output) => {
            output.amount += amount;
            return output;
          });
        }
      }

      if (src !== 0n || dst !== 0n) {
        throw new Error(
          `Error distributing collateral: src=${src}; dst=${dst}`,
        );
      }
    }
    return outputKeys;
  }

  public static getRootWinner(contests: Map<HashPrimitive, Contest>) {
    return this.getWinner(this.findContest(contests, null));
  }
}
