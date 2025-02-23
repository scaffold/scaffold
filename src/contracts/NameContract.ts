import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { nameHash } from '../hashes.ts';

export class NameContract implements ContractProvider {
  public contractHash = nameHash;

  public async compute(driver: ComputationDriver) {
    const name = await driver.params.open('name').getString();
    driver.body.setString(`Hello ${name}!`);
  }
}
