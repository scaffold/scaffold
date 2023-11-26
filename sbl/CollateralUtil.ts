import Hash, { EMPTY_HASH, HashPrimitive } from './util/Hash.ts';
import {
  CollateralContest,
  CollateralContractDetail,
} from '~/sbl/collateralMessages.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import { AccountContractParams, BlockOutput } from '~/sbl/messages.ts';
import { bin2hex } from '~/sbl/util/hex.ts';
import { accountHash, collateralHash } from '~/sbl/constants.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';

type DetailContest = CollateralContractDetail['contest'];
type DetailResult = CollateralContractDetail['result'];

export interface Posting {
  key?: Hash;
  detail: CollateralContractDetail;
  amount: bigint;
}
export interface Contest {
  spec: DetailContest;
  postings: Posting[];
  parentHash?: Hash;
  winner?: DetailResult;
  childWinner?: DetailResult;
  VALID: bigint;
  INVALID: bigint;
  INCONCLUSIVE: bigint;
}

export default class CollateralUtil {
  private static hashContest(contest: DetailContest) {
    return contest === null
      ? EMPTY_HASH
      : Hash.digest(CollateralContest.encode(contest.CollateralContest));
  }
  private static getParentHash(contest: DetailContest) {
    if (contest === null) {
      return undefined;
    } else if (contest.CollateralContest.hint === null) {
      return this.hashContest(null);
    } else {
      return this.hashContest({
        CollateralContest: {
          target: contest.CollateralContest.target,
          hint: null,
        },
      });
    }
  }

  private static isVoteValid(contest: DetailContest, vote: DetailResult) {
    if (contest === null) {
      return ['VALID'].includes(vote);
    } else if (contest.CollateralContest.hint === null) {
      return true;
    } else {
      return true;
    }
  }

  // NOTE: Postings must be sorted!
  public static getContests(postings: Iterable<Posting>) {
    const contests = new Map<HashPrimitive, Contest>();
    for (const posting of postings) {
      posting.key ??= this.hashContest(posting.detail.contest);

      getOrCreate(
        contests,
        posting.key.toPrimitive(),
        () => ({
          spec: posting.detail.contest,
          postings: [posting],
          parentHash: this.getParentHash(posting.detail.contest),
          VALID: 0n,
          INVALID: 0n,
          INCONCLUSIVE: 0n,
          [posting.detail.result]: posting.amount,
        }),
        (group) => {
          group.postings.push(posting);
          group[posting.detail.result] += posting.amount;
          return group;
        },
      );
    }
    return contests;
  }

  public static getWinner(contest: Contest) {
    const valid = contest.VALID && this.isVoteValid(contest.spec, 'VALID')
      ? contest.VALID
      : 0n;
    const invalid = contest.INVALID && this.isVoteValid(contest.spec, 'INVALID')
      ? contest.INVALID
      : 0n;
    const inconclusive =
      contest.INCONCLUSIVE && this.isVoteValid(contest.spec, 'INCONCLUSIVE')
        ? contest.INCONCLUSIVE
        : 0n;

    if (valid >= invalid) {
      if (valid >= inconclusive) {
        return 'VALID';
      } else {
        return 'INCONCLUSIVE';
      }
    } else {
      if (invalid > inconclusive) {
        return 'INVALID';
      } else {
        return 'INCONCLUSIVE';
      }
    }
  }

  public static updateWinners(contests: Map<HashPrimitive, Contest>) {
    for (const contest of contests.values()) {
      contest.winner = this.getWinner(contest);

      if (contest.spec !== null) {
        if (contest.spec.CollateralContest.hint !== null) {
          if (contest.winner === 'VALID' || contest.winner === 'INVALID') {
            const parentContest = {
              CollateralContest: {
                target: contest.spec.CollateralContest.target,
                hint: null,
              },
            };
            getOrCreate(
              contests,
              this.hashContest(parentContest).toPrimitive(),
              () => ({
                spec: parentContest,
                postings: [],
                parentHash: this.getParentHash(parentContest),
                VALID: 0n,
                INVALID: 0n,
                INCONCLUSIVE: 0n,
              }),
            );
          }
        }
      }
    }
    for (const contest of contests) {
      // contest.
    }
  }

  public static getOutputMap(contests: Iterable<Contest>) {
    // for (const contest of contests) {
    //   if (contest.spec.hint !== null) {
    //     contest.winner = getWinner(contest);
    //   }
    // }

    const outputKeys = new Map<string, BlockOutput>();
    for (const contest of contests) {
      const totalAmt = contest.VALID + contest.INVALID + contest.INCONCLUSIVE;
      const winAmt = contest[contest.winner!];
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
    }
    return outputKeys;
  }

  public static isValid(contests: Iterable<Contest>) {
    let valid = true;
    for (const contest of contests) {
      if (
        contest.INVALID > contest.VALID &&
        contest.INVALID > contest.INCONCLUSIVE
      ) {
        valid = false;
      }
    }
    return valid;
  }
}
