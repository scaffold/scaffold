import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { CollatzAnswer, CollatzParams } from './collatzMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';

export default class CollatzContract {
  constructor(private ctx: Context) {}

  public makeParams(num: bigint): Uint8Array {
    return CollatzParams.encode({ num });
  }

  public get() {
    const collatzGenerator = (
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

    const collatzContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      // Just run the generator and check it equals the candidate answer.
      arrEquals(
        collatzGenerator(contractHash, params, true, request),
        request(contractHash, params),
      );

    // This is a nasty hack until we get WASM working
    (window as any).collatzGenerator = collatzGenerator;
    (window as any).CollatzParams = CollatzParams;
    (window as any).CollatzAnswer = CollatzAnswer;

    const contract = this.ctx.get(GraphUtils).supplyContract(collatzContract);
    this.ctx.get(GraphUtils).supplyGenerator(contract, collatzGenerator);

    return contract;
  }
}
