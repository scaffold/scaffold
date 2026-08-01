import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';

export const AGGREGATION_CONTRACT = Hash.digest('aggregation');

export const aggregationContract: Contract = {
  async run(env) {
    console.log('a');
    await env.claim();
    console.log('b');
    await env.claim();
    console.log('c');
  },

  debug(params) {
    return `aggregation()`;
  },
};
