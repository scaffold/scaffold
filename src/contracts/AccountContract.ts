import { encodeDataTree } from '../DataTreeHelper.ts';
import { ComputationDriver, ComputationType } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { accountHash } from '../hashes.ts';

export const AccountContract: ContractProvider<{ publicKey: Uint8Array }> = {
  name: 'account',
  contractHash: accountHash,

  encodeParams: encodeDataTree,

  async compute(driver) {
    if (driver.type === ComputationType.Generator) {
      return;
    }

    const publicKey = await driver.params.open('publicKey').getBytes();
    driver.requireSignature(publicKey);
  },
};
