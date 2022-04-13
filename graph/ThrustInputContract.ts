import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as thrustMessages from './thrustMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';

// Inspiration:
// https://experiments.withgoogle.com/wpilot
// http://jfd.github.io/wpilot/

export default class ThrustInputContract {
  private inputCallbacks: Map<
    string,
    (time: bigint) => thrustMessages.InputEntry
  > = new Map();

  constructor(private ctx: Context) {}

  public makeParams(match: Hash, player: Hash, time: bigint): Uint8Array {
    return thrustMessages.InputParams.encode({ match, player, time });
  }

  public setInputCallback(
    match: Hash,
    player: Hash,
    cb: (time: bigint) => thrustMessages.InputEntry,
  ) {
    this.inputCallbacks.set(match.toHex() + player.toHex(), cb);
  }

  public get() {
    const thrustInputCallbacks = this.inputCallbacks;

    const thrustInputGenerator = (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      if (!emitCorrect) {
        return new TextEncoder().encode('DUPE');
      }

      const { match, player, time } = thrustMessages.InputParams.decode(params);

      const cb = thrustInputCallbacks.get(match.toHex() + player.toHex());
      if (cb) {
        return thrustMessages.InputAnswer.encode({
          entry: { InputEntry: cb(time) },
        });
      } else {
        return thrustMessages.InputAnswer.encode({ entry: null });
      }
    };

    const thrustInputContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      const answer = request(contractHash, params);
      thrustMessages.InputAnswer.decode(answer);
      return true;
    };

    // This is a nasty hack until we get WASM working
    (window as any).thrustInputGenerator = thrustInputGenerator;
    (window as any).thrustInputCallbacks = thrustInputCallbacks;
    (window as any).thrustMessages = thrustMessages;

    const contract = this.ctx.get(GraphUtils).supplyContract(
      thrustInputContract,
    );
    this.ctx.get(GraphUtils).supplyGenerator(contract, thrustInputGenerator);

    return contract;
  }
}
