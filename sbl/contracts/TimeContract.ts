import Context from '../Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import { TimeParams } from '../messages.ts';
import Hash from '../util/Hash.ts';
import { MaybePromise } from '../util/types.ts';
import { ComputationDriver } from '~/sbl/WorkerLauncherService.ts';

// Only used in tests,
// Used to make sure that generating time contracts "out-of-spec" never wins.
export const enum TimeGeneratorModifier {
  None,
}

export default class TimeContract {
  constructor(private ctx: Context) {}

  public compute(driver: ComputationDriver) {
    const { time } = TimeParams.decode(driver.getParams());
    driver.requireTimestampGte(time);
  }
}
