import { bin2str, str2bin } from '../../util/buffer.ts';
import { assert } from '../../util/functional.ts';
import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';
import { ValueType } from '../values.ts';

export const HELLO_CONTRACT = Hash.digest('hello');

export const helloContract: Contract = {
  run(env) {
    const name = bin2str(env.params());
    const response = str2bin(`Hello, ${name}`);
    env.setResult(response);
  },

  async buildParams(reader) {
    const x = await reader();
    assert(x?.type === ValueType.Map);
    const name = await x.at('name');
    assert(name?.type === ValueType.String);
    return str2bin(name.value);
  },

  walkParams(params, sink) {
    sink().setMap()?.at('name').setString(bin2str(params));
  },

  walkData(data, sink) {
    sink().setMap()?.at('message').setString(bin2str(data));
  },

  debug(params) {
    return `hello(${bin2str(params)})`;
  },
};
