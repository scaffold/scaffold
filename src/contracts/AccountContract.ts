import { ComputationDriver, ComputationType } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { accountHash } from '../hashes.ts';

export class AccountContract implements ContractProvider {
  public contractHash = accountHash;

  public async compute(driver: ComputationDriver) {
    if (driver.type === ComputationType.Generator) {
      return;
    }

    const publicKey = await driver.params.open('publicKey').getBytes();
    driver.requireSignature(publicKey);
  }
}
