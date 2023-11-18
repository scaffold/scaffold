import {
  ComputationDriver,
  ComputationType,
} from '~/sbl/WorkerLauncherService.ts';
import { AccountContractParams } from '~/sbl/messages.ts';
import { ContractProvider } from '~/sbl/SpecialContractManager.ts';
import { accountHash } from '~/sbl/constants.ts';

export default class AccountContract implements ContractProvider {
  public contractHash = accountHash;

  public compute(driver: ComputationDriver) {
    if (driver.type === ComputationType.Generator) {
      return;
    }

    const { public_key } = AccountContractParams.decode(driver.getParams());
    driver.requireSignature(public_key);
  }
}
