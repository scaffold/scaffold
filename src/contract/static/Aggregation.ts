import { EMPTY_ARR } from '../../util/buffer.ts';
import { assert } from '../../util/functional.ts';
import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';
import { ValueType } from '../values.ts';

export const AGGREGATION_CONTRACT = Hash.digest('aggregation');

export function serializeAggregationParams({ level }: { level: number }): Uint8Array {
  assert(Number.isInteger(level) && level >= 0 && level < 256);
  return new Uint8Array([level]);
}

export function deserializeAggregationParams(params: Uint8Array): { level: number } {
  assert(params.byteLength === 1);
  return { level: params[0] };
}

export const aggregationContract: Contract = {
  async run(env) {
    const { level } = deserializeAggregationParams(env.params());

    await env.claimOne();
    await env.claimOne();

    env.send(
      { contract: AGGREGATION_CONTRACT, params: serializeAggregationParams({ level: level + 1 }) },
      0n,
      EMPTY_ARR,
    );
  },

  async buildParams(source) {
    const root = await source();
    assert(root.type === ValueType.Map);
    const level = await root.at('level');
    assert(level?.type === ValueType.Number);
    return serializeAggregationParams({ level: level.value });
  },

  walkParams(params, sink) {
    const map = sink().setMap();
    map?.at('level').setNumber(deserializeAggregationParams(params).level);
    map?.close();
  },

  debug(params) {
    return `aggregation()`;
  },
};
