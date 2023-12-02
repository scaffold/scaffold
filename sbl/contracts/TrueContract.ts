import { ComputationDriver } from '~/sbl/ComputationMeta.ts';
import { ContractProvider } from '~/sbl/SpecialContractManager.ts';
import { trueHash } from '~/sbl/constants.ts';

export default class TrueContract implements ContractProvider {
  public contractHash = trueHash;

  public compute(_driver: ComputationDriver) {}
}
