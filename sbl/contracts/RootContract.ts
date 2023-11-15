import Context from '../Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import Hash, { HASH_SIZE } from '../util/Hash.ts';
import { MaybePromise } from '../util/types.ts';
import { rootHash } from '~/sbl/constants.ts';
import FactService from '~/sbl/FactService.ts';
import {
  BurdenOfProof,
  ComputationDriver,
  ComputationType,
} from '~/sbl/WorkerLauncherService.ts';

export default class RootContract {
  constructor(private ctx: Context) {}

  public compute(driver: ComputationDriver) {
    // TODO: How are errors handled here?
    const hash = Hash.fromBytes(driver.getParams());
    if (driver.type === ComputationType.Generator) {
      const fact = this.ctx.get(FactService).get(hash);
      if (fact) {
        driver.requireBody(fact.data);
      } else {
        driver.ingenerable();
      }
    } else if (driver.type === ComputationType.Contract) {
      const valid = Hash.equals(Hash.digest(driver.getBody()), hash);
      driver.setResult(valid);
    }
  }
}
