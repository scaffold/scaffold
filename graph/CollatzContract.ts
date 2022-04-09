import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { CollatzAnswer, CollatzParams } from './collatzMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';

export default class CollatzContract {
  constructor(private ctx: Context) {
    // This is a hack until we get WASM working
    (window as any).CollatzParams = CollatzParams;
    (window as any).CollatzAnswer = CollatzAnswer;
  }

  public makeParams(num: bigint): Uint8Array {
    return CollatzParams.encode({ num });
  }

  public get() {
    const contractFunc = (
      _contractHash: Hash,
      _params: Uint8Array,
      _hint: Uint8Array,
      _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      // TODO: Fix this contract
      const _ = 'collatz';
      return true;
    };

    const generatorFunc = (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      if (!emitCorrect) {
        return new TextEncoder().encode('DUPE');
      }

      const { num } = CollatzParams.decode(params);

      let answer: CollatzAnswer;
      if (num === 1n) {
        answer = { stopping_time: 0n, maximum: 1n };
      } else {
        const prev = CollatzAnswer.decode(
          request(
            contractHash,
            CollatzParams.encode({
              num: num % 2n ? num * 3n + 1n : num / 2n,
            }),
          ),
        );
        answer = {
          stopping_time: prev.stopping_time + 1n,
          maximum: num > prev.maximum ? num : prev.maximum,
        };
      }

      return CollatzAnswer.encode(answer);
    };

    const contract = this.ctx.get(GraphUtils).supplyContract(contractFunc);
    this.ctx.get(GraphUtils).supplyGenerator(contract, generatorFunc);

    return contract;
  }
}
