import { encodeDataTree } from '../DataTreeHelper.ts';
import { BurdenOfProof, ComputationDriver, ComputationType } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { accountHash, generatorHash } from '../hashes.ts';
import { Hash } from '../util/Hash.ts';

export const GeneratorContract: ContractProvider<{ contractHash: Hash }> = {
  name: 'generator',
  contractHash: generatorHash,

  encodeParams: encodeDataTree,

  async compute(driver) {
    const contractHash = driver.params.open('contractHash').getHash();
    const generatorHash = driver.body.getHash();

    const hint = driver.getHint(0, BurdenOfProof.Invalidation);
    // TODO: Run generatorHash using hint, check that the result is valid wrt contractHash
  },
};
