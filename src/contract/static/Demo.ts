import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';

export const DEMO_CONTRACT = Hash.digest('demo');

export const demoContract: Contract = {
  async run(env) {
    await env.claim();

    const name = new TextDecoder().decode(env.params());
    const response = new TextEncoder().encode(`Hello, ${name}`);
    env.setResult(response);
  },

  debug(params) {
    return `demo(${new TextDecoder().decode(params)})`;
  },
};
