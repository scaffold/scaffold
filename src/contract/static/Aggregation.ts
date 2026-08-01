import { Hash } from '../../util/Hash.ts';
import { Contract } from '../EnvContractProvider.ts';

export const AGGREGATION_CONTRACT = Hash.digest('aggregation');

export const aggregationContract: Contract = {
  run(env) {
  },

  debug(params) {
    return `aggregation()`;
  },
};
