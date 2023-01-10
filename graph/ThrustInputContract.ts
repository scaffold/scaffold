import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as thrustMessages from './thrustMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import QaDebugger from '~/sbl/QaDebugger.ts';

// Inspiration:
// https://experiments.withgoogle.com/wpilot
// http://jfd.github.io/wpilot/

export default class ThrustInputContract {
  private contract: Hash;

  private inputCallbacks: Map<
    string,
    (tick: bigint) => thrustMessages.InputEntry
  > = new Map();

  constructor(private ctx: Context) {
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

      const { match, player, tick } = thrustMessages.InputParams.decode(params);

      const cb = thrustInputCallbacks.get(match.toHex() + player.toHex());
      if (cb) {
        return thrustMessages.InputAnswer.encode({
          entry: { InputEntry: cb(tick) },
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

    this.contract = this.ctx.get(GraphUtils).supplyContract(
      thrustInputContract,
    );
    this.ctx.get(GraphUtils).supplyGenerator(
      this.contract,
      thrustInputGenerator,
    );

    this.ctx.get(QaDebugger).addDebugger(
      'ThrustInputContract',
      this.contract,
      (params) => thrustMessages.InputParams.decode(params),
      (answer) => thrustMessages.InputAnswer.decode(answer),
    );
  }

  public makeParams(match: Hash, player: Hash, tick: bigint): Uint8Array {
    return thrustMessages.InputParams.encode({ match, player, tick });
  }

  public setInputCallback(
    match: Hash,
    player: Hash,
    cb?: (tick: bigint) => thrustMessages.InputEntry,
  ) {
    const key = match.toHex() + player.toHex();
    if (cb) {
      this.inputCallbacks.set(key, cb);
    } else {
      this.inputCallbacks.delete(key);
    }
  }

  public get() {
    return this.contract;
  }
}
