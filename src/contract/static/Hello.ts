import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';
import { readString } from '../Reader.ts';

export const HELLO_CONTRACT = Hash.digest('hello');

export const helloContract: Contract = {
  run(env) {
    const name = new TextDecoder().decode(env.params());
    const response = new TextEncoder().encode(`Hello, ${name}`);
    env.setResult(response);
  },

  async buildParams(reader) {
    const name = await readString(await reader('parameters for the hello contract'), 'name', {
      type: 'string',
      shortDescription: 'Your name',
    });
    return str2bin(name);
  },

  debug(params) {
    return `hello(${new TextDecoder().decode(params)})`;
  },
};
