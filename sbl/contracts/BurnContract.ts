import { ComputationDriver } from '~/sbl/WorkerLauncherService.ts';
import { ContractProvider } from '~/sbl/SpecialContractManager.ts';
import { burnHash } from '~/sbl/constants.ts';

export default class BurnContract implements ContractProvider {
  public contractHash = burnHash;

  public compute(driver: ComputationDriver) {
    driver.fail();
  }
}
