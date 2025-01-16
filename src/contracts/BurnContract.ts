import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { burnHash } from '../hashes.ts';

export class BurnContract implements ContractProvider {
  public contractHash = burnHash;

  public compute(driver: ComputationDriver) {
    driver.fail(`A burn output cannot be spent`);
  }
}
