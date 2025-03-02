import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { nameHash } from '../hashes.ts';
import { encodeDataTree } from '../DataTreeHelper.ts';

export const NameContract: ContractProvider<{ name: string }> = {
  name: 'name',
  contractHash: nameHash,

  encodeParams: encodeDataTree,

  async compute(driver: ComputationDriver) {
    const name = await driver.params.open('name').getString();
    driver.body.setString(`Hello ${name}!`);
  },
};
