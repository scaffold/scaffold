import { assert } from '../../util/functional.ts';
import { Hash } from '../../util/Hash.ts';
import { hex2bin } from '../../util/hex.ts';
import { Predicate } from '../../graph/types.ts';
import { Contract } from '../env/Contract.ts';
import { VerificationFailure } from '../env/VerificationEnv.ts';
import { ParamsReader, serializeParams } from '../env/util/params.ts';
import { ValueType } from '../values.ts';
import { SIGNATURE_CONTRACT } from './Signature.ts';
import {
  applyMove,
  initialGameState,
  isTerminalStatus,
  STATUS_DRAW,
  STATUS_WHITE_WON,
  WHITE,
} from './chess/ChessRules.ts';
import { decodeAction, decodeSeed, decodeState, encodeState, matchId } from './chess/ChessCodec.ts';

export const CHESS_CONTRACT = Hash.digest('chess');

// Opens a match: stakes the pot and produces the first MOVE output.
export const CHESS_NEW = 'new';
// The right to play the next half-move of a match. The output under this predicate is the match:
// claiming it plays a move, and the block produces the next one under the same predicate.
export const CHESS_MOVE = 'move';

// A player who leaves this long between the block they are answering and their own forfeits the
// pot. This is a per-move deadline rather than legacy3's accumulating clock, because a contract
// can bound how early its block may be (`waitUntil`) but not how late.
export const MOVE_TIMEOUT_MS = 5 * 60 * 1000;

export const chessPredicate = (mode: string, match: string): Predicate => ({
  contract: CHESS_CONTRACT,
  params: serializeParams([mode, match]),
});

const playerPredicate = (publicKey: string): Predicate => ({
  contract: SIGNATURE_CONTRACT,
  params: hex2bin(publicKey),
});

const paramsOf = (params: Uint8Array) =>
  new ParamsReader({ params: (truncate) => params.subarray(0, truncate) });

// Malformed params, states and actions are refusals, not crashes: generation gives up and
// verification calls the block invalid.
function reject<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new VerificationFailure(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const chessContract: Contract = {
  async run(env) {
    // Each chess block is created with `scaffold.put({ ..., result })`: the opening block's result
    // names the players, every later block's result is that block's action. Carrying the action as
    // the result rather than a separate output means an illegal move is rejected as the block is
    // generated, instead of sitting in an output nobody can claim.
    const params = new ParamsReader(env);
    const mode = reject('chess params', () => params.read(0));
    const match = reject('chess params', () => matchId(params.read(1)));

    if (mode === CHESS_NEW) {
      const seed = reject('chess seed', () => decodeSeed(env.getResult()));
      // The pot is white's stake alone, so only white can open the match. Black matching it needs
      // a join handshake, and that needs both players to sign one block.
      env.sign(hex2bin(seed.white));
      const stake = await env.claimOne(undefined, playerPredicate(seed.white));
      env.send(
        chessPredicate(CHESS_MOVE, match),
        stake.amount,
        encodeState({ game: initialGameState(), ...seed }),
      );
      return;
    } else if (mode !== CHESS_MOVE) {
      throw new VerificationFailure(`chess params: unknown mode ${JSON.stringify(mode)}`);
    }

    // Read the action before claiming, so a node that was not asked to act gives up before
    // reserving the match.
    const action = reject('chess action', () => decodeAction(env.getResult()));

    const claimed = await env.claimOne();
    const state = reject('chess state', () => decodeState(claimed.body));
    const mover = state.game.toMove === WHITE ? state.white : state.black;
    const opponent = state.game.toMove === WHITE ? state.black : state.white;

    if (action.type === 'timeout') {
      // Only the opponent can call time, and only once the deadline has passed: `waitUntil` parks
      // the draft until then and rejects a block that claims it early.
      env.sign(hex2bin(opponent));
      await env.waitUntil(claimed.blockTimestampMs + MOVE_TIMEOUT_MS);
      env.send(playerPredicate(opponent), claimed.amount);
      return;
    }

    env.sign(hex2bin(mover));
    const game = reject('chess move', () => applyMove(state.game, action.move));

    if (!isTerminalStatus(game.status)) {
      env.send(chessPredicate(CHESS_MOVE, match), claimed.amount, encodeState({ ...state, game }));
      return;
    }

    if (game.status === STATUS_DRAW) {
      const half = claimed.amount / 2n;
      if (half > 0n) env.send(playerPredicate(state.black), half);
      env.send(playerPredicate(state.white), claimed.amount - half);
    } else {
      const winner = game.status === STATUS_WHITE_WON ? state.white : state.black;
      env.send(playerPredicate(winner), claimed.amount);
    }
  },

  async buildParams(source) {
    const root = await source();
    assert(root?.type === ValueType.Map);
    const mode = await root.at('mode');
    assert(mode?.type === ValueType.String);
    const match = await root.at('match');
    assert(match?.type === ValueType.String);
    return serializeParams([mode.value, matchId(match.value)]);
  },

  walkParams(params, sink) {
    const reader = paramsOf(params);
    const map = sink().setMap();
    map?.at('mode').setString(String(reader.read(0)));
    map?.at('match').setString(String(reader.read(1)));
    map?.close();
  },

  debug(params) {
    try {
      const reader = paramsOf(params);
      return `chess(${reader.read(0)}:${matchId(reader.read(1)).slice(0, 8)})`;
    } catch {
      return `chess(malformed)`;
    }
  },
};
