import { encodeDataTree } from '../DataTreeHelper.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { burnHash } from '../hashes.ts';

export const BurnContract: ContractProvider<{}> = {
  name: 'burn',
  contractHash: burnHash,

  encodeParams: encodeDataTree,

  compute(driver) {
    driver.fail(`A burn output cannot be spent`);
  },
};
