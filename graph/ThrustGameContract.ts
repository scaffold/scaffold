import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as thrustMessages from './thrustMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import ThrustInitContract from './ThrustInitContract.ts';
import ThrustInputContract from './ThrustInputContract.ts';
import * as timeMessages from './timeMessages.ts';
import TimeContract from './TimeContract.ts';
import QaDebugger from '~/sbl/QaDebugger.ts';

// Inspiration:
// https://experiments.withgoogle.com/wpilot
// http://jfd.github.io/wpilot/

export default class ThrustGameContract {
  constructor(private ctx: Context) {}

  // public makeParams(num: bigint): Uint8Array {
  //   return thrustMessages.Params.encode({ num });
  // }

  public get() {
    const thrustInitContractHash = this.ctx.get(ThrustInitContract).get().hash;
    const thrustInputContractHash =
      this.ctx.get(ThrustInputContract).get().hash;
    const timeContractHash = this.ctx.get(TimeContract).get().hash;

    const thrustGameGenerator = (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) => {
      if (!emitCorrect) {
        return new TextEncoder().encode('DUPE');
      }

      const { match, tick } = thrustMessages.GameParams.decode(params);

      const state = tick
        ? thrustMessages.GameAnswer.decode(
          request(
            contractHash,
            thrustMessages.GameParams.encode({ match, tick: tick - 1n }),
          ),
        )
        : {
          game_state: {
            center: { x: 0, y: 0 },
            velocity: { x: 0, y: 0 },
            size: 1000,
          },
          players: [],
          bullets: [],
        };

      // Notify network that we'll be requesting these contracts.
      // This isn't necessary, but without it, the network won't know which contracts will be requested until the previous call returns.
      // Basically, it lets the following request() calls happen in parallel instead of serially.
      // This corresponds to the open(2) system call, while the below request() corresponds to read(2).
      state.players.forEach(({ hash }) =>
        notify(
          thrustInputContractHash,
          thrustMessages.InputParams.encode({ match, player: hash, tick }),
        )
      );

      // Get game parameters
      const { init_time } = thrustMessages.InitAnswer.decode(
        request(
          thrustInitContractHash,
          thrustMessages.InitParams.encode({ match }),
        ),
      );

      if (tick === 7n) {
        console.log('77777777777', init_time + tick * 1000n);
      }
      // Wait for time
      request(
        timeContractHash,
        timeMessages.Params.encode({ time: init_time + tick * 1000n }),
      );
      if (tick === 7n) {
        Deno.exit(1);
      }

      let targCenterX = 0.0;
      let targCenterY = 0.0;
      state.players.forEach(({ hash, position, velocity, direction }) => {
        // Fetch player inputs
        const inputAnswer = request(
          thrustInputContractHash,
          thrustMessages.InputParams.encode({ match, player: hash, tick }),
        );
        const { entry } = thrustMessages.InputAnswer.decode(inputAnswer);
        const input: thrustMessages.InputEntry = entry ? entry.InputEntry : {
          pressing_fwd: false,
          pressing_bwd: false,
          pressing_left: false,
          pressing_right: false,
          pressing_fire: false,
        };

        // Steer
        if (input.pressing_left || input.pressing_right) {
          const steerAmt = input.pressing_left ? 0.01 : -0.01;
          const { x, y } = direction;
          direction.x = x * Math.cos(steerAmt) - y * Math.sin(steerAmt);
          direction.y = x * Math.sin(steerAmt) + y * Math.cos(steerAmt);
        }

        {
          // Normalize direction
          const d = Math.sqrt(
            direction.x * direction.x + direction.y * direction.y,
          );
          direction.x /= d;
          direction.y /= d;
        }

        // Accelerate
        if (input.pressing_fwd) {
          velocity.x += direction.x;
          velocity.y += direction.y;
        }

        position.x += velocity.x;
        position.y += velocity.y;
        velocity.x *= 0.999;
        velocity.y *= 0.999;

        {
          // Enforce boundaries
          const dx = position.x - state.game_state.center.x;
          const dy = position.y - state.game_state.center.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const out = d - state.game_state.size;
          if (out > 0) {
            const f = out / d * 1e-3;
            velocity.x -= dx * f;
            velocity.y -= dy * f;
          }
        }

        targCenterX += position.x;
        targCenterY += position.y;
      });

      {
        // Move boundaries
        const { center, velocity } = state.game_state;
        center.x += velocity.x;
        center.y += velocity.y;
        velocity.x = velocity.x * 0.99 + (targCenterX - center.x) * 0.01;
        velocity.y = velocity.y * 0.99 + (targCenterY - center.y) * 0.01;
      }

      const targSize = Math.sqrt(state.players.length || 1) * 1000;
      state.game_state.size = state.game_state.size * 0.9999 +
        targSize * 0.0001;

      return thrustMessages.GameAnswer.encode(state);
    };

    const thrustGameContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) =>
      // Just run the generator and check it equals the candidate answer.
      arrEquals(
        thrustGameGenerator(contractHash, params, true, request, notify),
        request(contractHash, params),
      );

    // This is a nasty hack until we get WASM working
    (window as any).thrustGameGenerator = thrustGameGenerator;
    (window as any).thrustMessages = thrustMessages;
    (window as any).thrustInitContractHash = thrustInitContractHash;
    (window as any).thrustInputContractHash = thrustInputContractHash;
    (window as any).timeContractHash = timeContractHash;

    const contract = this.ctx.get(GraphUtils).supplyContract(
      thrustGameContract,
    );
    this.ctx.get(GraphUtils).supplyGenerator(contract, thrustGameGenerator);

    this.ctx.get(QaDebugger).addDebugger(
      'ThrustGameContract',
      contract.hash,
      (params) => thrustMessages.GameParams.decode(params),
      (answer) => thrustMessages.GameAnswer.decode(answer),
    );

    return contract;
  }
}
