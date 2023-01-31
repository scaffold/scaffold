import Context from '../sbl/Context.ts';
import LocalGeneratorService from '../sbl/LocalGeneratorService.ts';
import Hash from '../sbl/util/Hash.ts';
import * as thrustMessages from '../ts/thrustMessages.ts';
import * as moduleHashes from './moduleHashes.ts';

export default class ThrustInputProvider {
  private inputCallbacks: Map<
    string,
    (tick: bigint) => thrustMessages.InputEntry
  > = new Map();

  constructor(private ctx: Context) {
    ctx.get(LocalGeneratorService).addGenerator(
      moduleHashes.thrust_input_wasm_hash,
      ({ params, emitCorrect }) => {
        if (!emitCorrect) {
          return new TextEncoder().encode('DUPE');
        }

        const { match, player, tick } = thrustMessages.InputParams.decode(
          params,
        );

        const cb = this.inputCallbacks.get(match.toHex() + player.toHex());
        if (cb) {
          return thrustMessages.InputAnswer.encode({
            entry: { InputEntry: cb(tick) },
          });
        } else {
          return thrustMessages.InputAnswer.encode({ entry: null });
        }
      },
    );
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
}
