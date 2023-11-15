import Context from '~/sbl/Context.ts';
import { ComputationDriver } from '~/sbl/WorkerLauncherService.ts';
import { AccountContractParams } from '~/sbl/messages.ts';

export default class AccountContract {
  constructor(private ctx: Context) {}

  public compute(driver: ComputationDriver) {
    const { public_key } = AccountContractParams.decode(driver.getParams());
    driver.requireSignature(public_key);
  }
}
