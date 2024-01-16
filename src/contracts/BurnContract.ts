import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { burnHash } from '../constants.ts';

export default class BurnContract implements ContractProvider {
  public contractHash = burnHash;

  public compute(driver: ComputationDriver) {
    driver.fail();
  }
}
