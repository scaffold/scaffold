import { ComputationDriver } from '../ComputationMeta.ts';
import { encodeDataTree } from '../DataTreeHelper.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { trueHash } from '../hashes.ts';

export const TrueContract: ContractProvider<{}> = {
  name: 'true',
  contractHash: trueHash,

  encodeParams: encodeDataTree,

  compute(_driver: ComputationDriver) {},
};
