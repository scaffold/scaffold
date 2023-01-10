import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as timeMessages from './timeMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import QaDebugger from '~/sbl/QaDebugger.ts';

export default class TimeContract {
  constructor(private ctx: Context) {}

  public makeParams(time: bigint): Uint8Array {
    return timeMessages.Params.encode({ time });
  }

  public get() {
    const timeGenerator = async (
      _contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      if (!emitCorrect) {
        return new TextEncoder().encode('DUPE');
      }

      const { time } = timeMessages.Params.decode(params);

      const wait = Number(time) - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      return timeMessages.Answer.encode({});
    };

    const timeContract = async (
      contractHash: Hash,
      params: Uint8Array,
      _hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      // Just run the generator and check it equals the candidate answer.
      arrEquals(
        await timeGenerator(contractHash, params, true, request),
        request(contractHash, params),
      );

    // This is a nasty hack until we get WASM working
    (window as any).timeGenerator = timeGenerator;
    (window as any).timeMessages = timeMessages;

    const contract = this.ctx.get(GraphUtils).supplyContract(timeContract);
    this.ctx.get(GraphUtils).supplyGenerator(contract, timeGenerator);

    this.ctx.get(QaDebugger).addDebugger(
      'TimeContract',
      contract,
      (params) => timeMessages.Params.decode(params),
      (answer) => timeMessages.Answer.decode(answer),
    );

    return contract;
  }
}
