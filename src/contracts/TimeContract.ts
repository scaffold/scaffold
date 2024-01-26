import { TimeParams } from '../messages.ts';
import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { timeHash } from '../constants.ts';

// Only used in tests,
// Used to make sure that generating time contracts "out-of-spec" never wins.
export const enum TimeGeneratorModifier {
  None,
}

export class TimeContract implements ContractProvider {
  public contractHash = timeHash;

  public compute(driver: ComputationDriver) {
    const { time } = TimeParams.decode(driver.getParams());
    driver.requireTimestampGte(time);
  }
}
