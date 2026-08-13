import { bin2str, str2bin } from '../../util/buffer.ts';
import { assert, error } from '../../util/functional.ts';
import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';
import { ValueType } from '../values.ts';

export const HELLO_CONTRACT = Hash.digest('hello');

export const helloContract: Contract = {
  run(env) {
    const name = bin2str(env.params());
    const response = str2bin(`Hello ${name}!`);
    env.setResult(response);
  },

  async buildParams(source) {
    const root = await source();
    const name = root.type === ValueType.Map
      ? (await root.at('name')) ?? error('Hello params missing "name" property')
      : root;
    assert(name.type === ValueType.String);
    return str2bin(name.value);
  },

  walkParams(params, sink) {
    const map = sink().setMap();
    map?.at('name').setString(bin2str(params));
    map?.close();
  },

  async buildBody(source) {
    const root = await source();
    assert(root.type === ValueType.Map);
    const message = await root.at('message');
    assert(message?.type === ValueType.String);
    return str2bin(message.value);
  },

  walkBody(body, sink) {
    const map = sink().setMap();
    map?.at('message').setString(bin2str(body));
    map?.close();
  },

  debug(params) {
    return `hello(${bin2str(params)})`;
  },
};
