import {
  ComputationDriver,
  ComputationType,
  InputSource,
} from '~/sbl/ComputationMeta.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
} from '~/sbl/collateralMessages.ts';
import { accountHash, collateralHash } from '~/sbl/constants.ts';
import { ContractProvider } from '~/sbl/SpecialContractManager.ts';
import CollateralUtil, { Posting } from '~/sbl/CollateralUtil.ts';

// Only used in tests,
// Used to make sure that generating collateral contracts "out-of-spec" never wins.
export const enum CollateralGeneratorModifier {
  None,
  OmitFor,
  OmitAgainst,
}

const DEBUG = true;
const resolutionDelay = 5000n;

export default class CollateralContract implements ContractProvider {
  public contractHash = collateralHash;

  public async compute(driver: ComputationDriver) {
    const _params = CollateralContractParams.decode(driver.getParams());

    const postings: (Omit<InputSource, 'detail'> & Posting)[] = [];
    const inputCount = await driver.getInputCount();
    for (let i = 0; i < inputCount; i++) {
      const source = await driver.getInputSource(i);
      await driver.requireTimestampGte(source.blockTimestamp + resolutionDelay);
      postings.push({
        ...source,
        detail: CollateralContractDetail.decode(source.detail),
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

    const desc = CollateralUtil.buildTree(postings);
    const isValid = CollateralUtil.isValid(desc);
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
  }
}
