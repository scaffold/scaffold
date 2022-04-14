import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as collatzMessages from './collatzMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import QaDebugger from '~/sbl/QaDebugger.ts';

export default class CollatzContract {
  constructor(private ctx: Context) {}

  public makeParams(num: bigint): Uint8Array {
    return collatzMessages.Params.encode({ num });
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

      const { num } = collatzMessages.Params.decode(params);

      let answer: collatzMessages.Answer;
      if (num === 1n) {
        answer = { stopping_time: 0n, maximum: 1n };
      } else {
        const prev = collatzMessages.Answer.decode(
          request(
            contractHash,
            collatzMessages.Params.encode({
              num: num % 2n ? num * 3n + 1n : num / 2n,
            }),
          ),
        );
        answer = {
          stopping_time: prev.stopping_time + 1n,
          maximum: num > prev.maximum ? num : prev.maximum,
        };
      }

      return collatzMessages.Answer.encode(answer);
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
    (window as any).collatzMessages = collatzMessages;

    const contract = this.ctx.get(GraphUtils).supplyContract(collatzContract);
    this.ctx.get(GraphUtils).supplyGenerator(contract, collatzGenerator);

    this.ctx.get(QaDebugger).addDebugger(
      'CollatzContract',
      contract.hash,
      (params) => collatzMessages.Params.decode(params),
      (answer) => collatzMessages.Answer.decode(answer),
    );

    return contract;
  }
}
