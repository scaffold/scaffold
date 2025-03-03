import { ComputationDriver, ComputationType, InputSource } from '../ComputationMeta.ts';
import { CollateralContractDetail, CollateralContractParams } from '../collateralMessages.ts';
import { accountHash, collateralHash } from '../hashes.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { CollateralUtil, Posting } from '../CollateralUtil.ts';
import { Hash } from '../util/Hash.ts';
import { encodeDataTree } from '../DataTreeHelper.ts';

// Only used in tests,
// Used to make sure that generating collateral contracts "out-of-spec" never wins.
export const enum CollateralGeneratorModifier {
  None,
  OmitFor,
  OmitAgainst,
}

const DEBUG = true;
const resolutionDelayMs = 5000;

export const CollateralContract: ContractProvider<Hash> = {
  name: 'collateral',
  contractHash: collateralHash,

  encodeParams: encodeDataTree,

  async compute(driver) {
    await driver.params.getHash();

    const postings: (InputSource & Posting)[] = [];
    for (const input of await driver.collectInputs()) {
      await driver.requireTimestampGte(Number(input.timestamp) + resolutionDelayMs);
      postings.push({
        ...input,
        detail: CollateralContractDetail.decode(input.output.detail.value!.bytes),
        amount: input.output.amount,
      });
    }

    if (driver.type === ComputationType.Generator) {
      // Sort
      postings.sort((a, b) =>
        driver.compareBlockOrder(a.input.block.hash, b.input.block.hash) ||
        a.input.outputIdx - b.input.outputIdx
      );
    } else if (driver.type === ComputationType.Contract) {
      // Assert sorted
      for (let i = 1; i < postings.length; i++) {
        const a = postings[i - 1];
        const b = postings[i];
        const cmp = driver.compareBlockOrder(a.input.block.hash, b.input.block.hash) ||
          a.input.outputIdx - b.input.outputIdx;
        if (cmp >= 0) {
          driver.fail(`Collateral inputs aren't sorted!`);
        }
      }
    }

    const desc = CollateralUtil.buildTree(postings);
    // const isValid = CollateralUtil.isValid(desc);
    const outputMap = CollateralUtil.getOutputMap(desc);

    if (DEBUG) {
      const totalIn = postings.reduce((acc, cur) => acc + cur.amount, 0n);
      let totalOut = 0n;
      for (const output of outputMap.values()) {
        totalOut += output.amount;
      }
      if (totalIn !== totalOut) {
        throw new Error(`Invalid throughput; ${totalIn} !== ${totalOut}!`);
      }
    }

    for (const output of outputMap.values()) {
      driver.requireOutput(output);
    }

    // TODO: Do something, maybe involving the fronteir vote, frontier level, or timestamp, to block resolution at least until the block is included in a frontier tree parent?
  },
};
