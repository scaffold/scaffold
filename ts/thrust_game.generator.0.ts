import { LocalGenerator } from '../sbl/LocalGeneratorService.ts';
import Hash from '../sbl/util/Hash.ts';
import * as moduleHashes from './moduleHashes.ts';
import * as thrustMessages from './thrustMessages.ts';

// Inspiration:
// https://experiments.withgoogle.com/wpilot
// http://jfd.github.io/wpilot/

const gen: LocalGenerator = async (
  { ctx, contractHash, params, emitCorrect, request, notify },
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
        size: 10,
      },
      players: [{
        hash: Hash.digest(ctx.config.selfPrivateKey),
        position: { x: 10, y: 0 },
        velocity: { x: 0, y: 0 },
        angle_rads: 0,
      }],
      bullets: [],
    };

  // Notify network that we'll be requesting these contracts.
  // This isn't necessary, but without it, the network won't know which contracts will be requested until the previous call returns.
  // Basically, it lets the following request() calls happen in parallel instead of serially.
  // This corresponds to the open(2) system call, while the below request() corresponds to read(2).
  state.players.forEach(({ hash }) =>
    notify(
      moduleHashes.thrust_input_wasm_hash,
      thrustMessages.InputParams.encode({ match, player: hash, tick }),
    )
  );

  // Get game parameters
  const { init_time } = thrustMessages.InitAnswer.decode(
    request(
      moduleHashes.thrust_init_wasm_hash,
      thrustMessages.InitParams.encode({ match }),
    ),
  );

  // Wait until time
  const waitUntil = Number(init_time + tick * 100n);
  await new Promise((resolve) => setTimeout(resolve, waitUntil - Date.now()));

  // TODO: Use time contract
  // request(
  //   timeContractHash,
  //   timeMessages.Params.encode({ time: init_time + tick * 100n }),
  // );

  let targCenterX = 0.0;
  let targCenterY = 0.0;
  state.players.forEach((player) => {
    const { hash, position, velocity } = player;

    // Fetch player inputs
    const inputAnswer = request(
      moduleHashes.thrust_input_wasm_hash,
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
      player.angle_rads += input.pressing_left ? 0.1 : -0.1;
    }

    // Accelerate
    if (input.pressing_fwd) {
      const acceleration = 0.1;
      velocity.x += Math.cos(player.angle_rads) * acceleration;
      velocity.y += Math.sin(player.angle_rads) * acceleration;
    }

    position.x += velocity.x;
    position.y += velocity.y;
    velocity.x *= 0.9;
    velocity.y *= 0.9;

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

  // Move boundaries
  const { center, velocity } = state.game_state;
  center.x += velocity.x;
  center.y += velocity.y;
  velocity.x *= 0.5;
  velocity.y *= 0.5;

  if (state.players.length) {
    targCenterX /= state.players.length;
    targCenterY /= state.players.length;

    velocity.x += (targCenterX - center.x) * 0.4;
    velocity.y += (targCenterY - center.y) * 0.4;
  }

  const targSize = Math.sqrt(state.players.length || 1) * 10;
  state.game_state.size = state.game_state.size * 0.9999 +
    targSize * 0.0001;

  return thrustMessages.GameAnswer.encode(state);
};

export default gen;
