import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { trueHash } from '../hashes.ts';

export class TrueContract implements ContractProvider {
  public contractHash = trueHash;

  public compute(_driver: ComputationDriver) {}
}
