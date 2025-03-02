import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { timeHash } from '../hashes.ts';
import { encodeDataTree } from '../DataTreeHelper.ts';

// Only used in tests,
// Used to make sure that generating time contracts "out-of-spec" never wins.
export const enum TimeGeneratorModifier {
  None,
}

export const TimeContract: ContractProvider<{ time: bigint }> = {
  name: 'time',
  contractHash: timeHash,

  encodeParams: encodeDataTree,

  async compute(driver) {
    const time = await driver.params.open('time').getBigInt();
    driver.requireTimestampGte(time);
  },
};
