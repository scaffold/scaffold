import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';

export const AGGREGATION_CONTRACT = Hash.digest('aggregation');

export const aggregationContract: Contract = {
  async run(env) {
    await env.claim();
    await env.claim();
  },

  debug(params) {
    return `aggregation()`;
  },
};
