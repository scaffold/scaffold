import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { trueHash } from '../constants.ts';

export class TrueContract implements ContractProvider {
  public contractHash = trueHash;

  public compute(_driver: ComputationDriver) {}
}
