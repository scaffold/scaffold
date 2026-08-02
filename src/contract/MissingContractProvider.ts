import { error } from '../util/functional.ts';
import { Hash } from '../util/Hash.ts';
import { ContractProvider } from './ContractProvider.ts';
import { Predicate } from '../graph/types.ts';

const predError = (predicate: Predicate) =>
  error(`No matching contract registered for ${predicate.contract.toHex()}`);
const contractError = (contract: Hash) =>
  error(`No matching contract registered for ${contract.toHex()}`);

export class MissingContractProvider implements ContractProvider {
  generate = predError;
  verify = predError;
  buildParams = contractError;
  buildData = contractError;
  walkParams = contractError;
  walkData = contractError;
}
