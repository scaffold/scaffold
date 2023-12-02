import Context from '../Context.ts';
import Hash, { HASH_SIZE } from '../util/Hash.ts';
import FactService from '~/sbl/FactService.ts';
import {
  ComputationDriver,
  ComputationType,
} from '~/sbl/WorkerLauncherService.ts';
import { ContractProvider } from '~/sbl/SpecialContractManager.ts';
import { rootHash } from '~/sbl/constants.ts';

export default class RootContract implements ContractProvider {
  public contractHash = rootHash;

  public compute(driver: ComputationDriver, ctx: Context) {
    // TODO: How are errors handled here?
    const hash = Hash.fromBytes(driver.getParams());
    if (driver.type === ComputationType.Generator) {
      const fact = ctx.get(FactService).get(hash, false);
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
