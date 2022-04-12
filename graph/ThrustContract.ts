import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as thrustMessages from './thrustMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';

export default class ThrustContract {
  constructor(private ctx: Context) {}

  // public makeParams(num: bigint): Uint8Array {
  //   return thrustMessages.Params.encode({ num });
  // }

  public get() {
    const thrustGenerator = (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      if (!emitCorrect) {
        return new TextEncoder().encode('DUPE');
      }

      return new Uint8Array([]);
    };

    const thrustContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      // Just run the generator and check it equals the candidate answer.
      arrEquals(
        thrustGenerator(contractHash, params, true, request),
        request(contractHash, params),
      );

    // This is a nasty hack until we get WASM working
    (window as any).thrustGenerator = thrustGenerator;
    (window as any).thrustMessages = thrustMessages;

    const contract = this.ctx.get(GraphUtils).supplyContract(thrustContract);
    this.ctx.get(GraphUtils).supplyGenerator(contract, thrustGenerator);

    return contract;
  }
}
