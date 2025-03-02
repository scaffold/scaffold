import { encodeDataTree } from '../DataTreeHelper.ts';
import { ComputationDriver, ComputationType } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { accountHash } from '../hashes.ts';
import { Hash } from '../util/Hash.ts';

// TODO: Parameterize by public key hash
export const AccountContract: ContractProvider<{ publicKey: Uint8Array }> = {
  name: 'account',
  contractHash: accountHash,

  encodeParams: encodeDataTree,

  async compute(driver) {
    if (driver.type === ComputationType.Generator) {
      return;
    }

    const publicKey = await driver.params.open('publicKey').getBytes();
    driver.requireSignature(Hash.digest(publicKey));
  },
};
