import { ComputationDriver, ComputationType } from '../ComputationMeta.ts';
import { AccountContractParams } from '../messages.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { accountHash } from '../constants.ts';

export class AccountContract implements ContractProvider {
  public contractHash = accountHash;

  public compute(driver: ComputationDriver) {
    if (driver.type === ComputationType.Generator) {
      return;
    }

    const { publicKey } = AccountContractParams.decode(driver.getParams());
    driver.requireSignature(publicKey);
  }
}
