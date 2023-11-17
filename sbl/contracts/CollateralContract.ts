import Context from '../Context.ts';
import { Collateralization } from '~/sbl/FactMeta.ts';
import Hash, { HashPrimitive } from '../util/Hash.ts';
import {
  ComputationDriver,
  ComputationType,
} from '~/sbl/WorkerLauncherService.ts';
import {
  CollateralContest,
  CollateralContractDetail,
  CollateralContractParams,
} from '~/sbl/collateralMessages.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import { AccountContractParams, BlockOutput } from '~/sbl/messages.ts';
import { bin2hex } from '~/sbl/util/hex.ts';
import { accountHash } from '~/sbl/constants.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';

// Only used in tests,
// Used to make sure that generating collateral contracts "out-of-spec" never wins.
export const enum CollateralGeneratorModifier {
  None,
  OmitFor,
  OmitAgainst,
}

const DEBUG = true;
const resolutionDelay = 5000n;

export default class CollateralContract {
  constructor(private ctx: Context) {}

  public async compute(driver: ComputationDriver) {
    // const blockHash =
    //   CollateralContractParams.decode(driver.getParams()).block_hash;

    interface Posting {
      blockHash: Hash;
      key?: Hash;
      detail: CollateralContractDetail;
      amount: bigint;
    }
    const postings: Posting[] = [];

    const inputCount = await driver.getInputCount();
    for (let i = 0; i < inputCount; i++) {
      const source = await driver.getInputSource(i);
      await driver.requireTimestampGte(source.blockTimestamp + resolutionDelay);
      postings.push({
        blockHash: source.blockHash,
        detail: CollateralContractDetail.decode(source.detail),
        amount: source.amount,
      });
    }

    if (driver.type === ComputationType.Generator) {
      // Sort
      postings.sort((a, b) =>
        driver.compareBlockOrder(a.blockHash, b.blockHash)
      );
    } else if (driver.type === ComputationType.Contract) {
      // Assert sorted
      for (let i = 1; i < postings.length; i++) {
        if (
          driver.compareBlockOrder(
            postings[i - 1].blockHash,
            postings[i].blockHash,
          ) !== -1
        ) {
          driver.fail();
        }
      }
    }

    interface Contest {
      spec: CollateralContest;
      postings: Posting[];
      winner?: CollateralContractDetail['result'];
      VALID: bigint;
      INVALID: bigint;
      INCONCLUSIVE: bigint;
    }
    const contests = new Map<HashPrimitive, Contest>();
    for (const posting of postings) {
      // posting.detail.contest.hint === null;

      posting.key = Hash.digest(
        CollateralContest.encode(posting.detail.contest),
      );
      getOrCreate(
        contests,
        posting.key.toPrimitive(),
        () => ({
          spec: posting.detail.contest,
          postings: [posting],
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

    let valid = true;
    for (const contest of contests.values()) {
      if (
        contest.INVALID > contest.VALID &&
        contest.INVALID > contest.INCONCLUSIVE
      ) {
        valid = false;
      }
    }

    const getWinner = (contest: Contest) => {
      if (contest.VALID >= contest.INVALID) {
        if (contest.VALID >= contest.INCONCLUSIVE) {
          return 'VALID';
        } else {
          return 'INCONCLUSIVE';
        }
      } else {
        if (contest.INVALID > contest.INCONCLUSIVE) {
          return 'INVALID';
        } else {
          return 'INCONCLUSIVE';
        }
      }
    };

    // for (const contest of contests.values()) {
    //   if (contest.spec.hint !== null) {
    //     contest.winner = getWinner(contest);
    //   }
    // }

    const outputKeys = new Map<string, BlockOutput>();
    for (const contest of contests.values()) {
      contest.winner ??= getWinner(contest);

      const totalAmt = contest.VALID + contest.INVALID + contest.INCONCLUSIVE;
      const winAmt = contest[contest.winner];
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

    if (DEBUG) {
      const totalIn = postings.reduce((acc, cur) => acc + cur.amount, 0n);
      let totalOut = 0n;
      for (const output of outputKeys.values()) {
        totalOut += output.amount;
      }
      if (totalIn !== totalOut) {
        throw new Error(`Invalid throughput; ${totalIn} !== ${totalOut}!`);
      }
    }

    for (const output of outputKeys.values()) {
      driver.requireOutput(output);
    }

    // let remainingAllValid = contests.get(
    //   Hash.digest(
    //     CollateralContest.encode({
    //       target: { CollateralTargetAllValid: {} },
    //       hint: null,
    //     }),
    //   ).toPrimitive(),
    // );
    // for (const posting of postings) {
    //   contests.get(posting.key!.toPrimitive())!;
    // }

    /*
    AllValid {}
    InputHash {index: 0}
    InputHash {index: 0, hint: }


    For fair verifiers, just
    Distribute N allValid coins amongst first N coins placed in groups eventually invalidating the block.

    */

    // this.ctx.get(BlockService).sort(fact.collateralizations, frontierVote);
  }
}
