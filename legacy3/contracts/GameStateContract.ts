// Chess demo: game-state contract.
//
// A single GAME_STATE UTXO carries the right-to-move. Each move block claims
// the previous GAME_STATE and either produces the next one (non-terminal) or
// pays out the pot as signature outputs (terminal).
//
// Output namespaces owned: GAME_STATE_CONTRACT, RECORD_CONTRACT. SIGNATURE_CONTRACT
// is deliberately NOT declared -- it's left unowned so the block creation layer
// can insert change outputs freely (throughput balance still contains theft).

import { GAME_STATE_CONTRACT, RECORD_CONTRACT, SIGNATURE_CONTRACT } from '../core/Block.ts';
import { ContractRejection } from '../core/ContractEnv.ts';
import type { Contract } from './Contract.ts';
import {
  applyMove,
  CASTLE_BK,
  CASTLE_BQ,
  CASTLE_WK,
  CASTLE_WQ,
  EP_NONE,
  initialBoard,
  isTerminalStatus,
  isTimeoutMove,
  type Move,
  STATUS_AWAITING_JOIN,
  STATUS_BLACK_WON,
  STATUS_DRAW,
  STATUS_IN_PROGRESS,
  STATUS_TIMEOUT_BLACK,
  STATUS_TIMEOUT_WHITE,
  STATUS_WHITE_WON,
  WHITE,
} from '../demo/chess/ChessRules.ts';
import {
  decodeGameParams,
  decodeGameState,
  decodeMove,
  encodeGameParams,
  encodeGameState,
  type GameStateEnvelope,
} from '../demo/chess/GameStateCodec.ts';

/** Key bytes for the "move" record slot carried on each move block. */
const MOVE_KEY = new TextEncoder().encode('move');
/** Key bytes for the "join" record slot carried on the join block. */
const JOIN_KEY = new TextEncoder().encode('join');

/** Starting-position clock defaults, matched against join-time state. */
const INITIAL_CLOCK_MS = 5 * 60 * 1000;
const ALL_CASTLING = CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Validate the previous state's shape for an awaiting_join claim: ensure white
 * published an honest starting position (board + flags + clocks). If this
 * fails, black (or any observer) can refuse to join.
 */
function assertFreshInitial(env: GameStateEnvelope): void {
  const s = env.state;
  if (s.status !== STATUS_AWAITING_JOIN) {
    throw new ContractRejection('awaiting_join branch but status mismatch');
  }
  if (!bytesEqual(s.board, initialBoard())) {
    throw new ContractRejection('initial board does not match standard position');
  }
  if (s.toMove !== WHITE) throw new ContractRejection('initial toMove must be WHITE');
  if (s.castling !== ALL_CASTLING) {
    throw new ContractRejection('initial castling rights must be full');
  }
  if (s.enPassant !== EP_NONE) throw new ContractRejection('initial en-passant must be NONE');
  if (s.halfmoveClock !== 0) throw new ContractRejection('initial halfmove clock must be 0');
  if (s.fullmove !== 1) throw new ContractRejection('initial fullmove must be 1');
  if (s.whiteClockMs !== INITIAL_CLOCK_MS || s.blackClockMs !== INITIAL_CLOCK_MS) {
    throw new ContractRejection('initial clocks must be 5 minutes each');
  }
  if (!env.black.every((b) => b === 0)) {
    throw new ContractRejection('initial envelope must have zero black pubkey');
  }
  if (env.white.length !== 33) throw new ContractRejection('white pubkey must be 33 bytes');
}

export const gameStateContract: Contract = {
  outputNamespaces: [GAME_STATE_CONTRACT, RECORD_CONTRACT],

  async run(env) {
    const prevInput = await env.claimNext();
    let prev: GameStateEnvelope;
    try {
      prev = decodeGameState(prevInput.body);
    } catch (e) {
      throw new ContractRejection('previous game state malformed: ' + (e as Error).message);
    }

    let params;
    try {
      params = decodeGameParams(env.params());
    } catch (e) {
      throw new ContractRejection('game params malformed: ' + (e as Error).message);
    }

    const { gameId, turnId } = params;
    const nextParamsBytes = encodeGameParams(gameId, turnId + 1);
    const now = env.timestamp();

    // -- JOIN ----------------------------------------------------------
    if (prev.state.status === STATUS_AWAITING_JOIN) {
      assertFreshInitial(prev);

      const joinSlot = await env.request({
        contract: RECORD_CONTRACT,
        params: JOIN_KEY,
      });
      const blackPubkey = joinSlot.body;
      if (blackPubkey.length !== 33) {
        throw new ContractRejection('black pubkey must be 33 bytes');
      }
      if (bytesEqual(blackPubkey, prev.white)) {
        throw new ContractRejection('black and white must be distinct');
      }

      env.sign(blackPubkey);

      const joined: GameStateEnvelope = {
        state: {
          board: initialBoard(),
          toMove: WHITE,
          castling: ALL_CASTLING,
          enPassant: EP_NONE,
          halfmoveClock: 0,
          fullmove: 1,
          whiteClockMs: INITIAL_CLOCK_MS,
          blackClockMs: INITIAL_CLOCK_MS,
          lastMoveAt: now,
          status: STATUS_IN_PROGRESS,
        },
        white: prev.white,
        black: blackPubkey,
      };

      env.send(
        { contract: GAME_STATE_CONTRACT, params: nextParamsBytes },
        prevInput.value * 2,
        encodeGameState(joined),
      );
      return;
    }

    if (isTerminalStatus(prev.state.status)) {
      throw new ContractRejection('game is already finished');
    }

    // -- NORMAL MOVE ---------------------------------------------------
    const mover = prev.state.toMove === WHITE ? prev.white : prev.black;

    // Require the mover's signature BEFORE reading the move. In
    // generation mode this throws ContractRejection on every node
    // whose signing pubkey isn't the mover, so the parked-on-requestBody
    // path never runs on the opponent or third-party observers --
    // their drafts cancel before the phantom claim reserves the
    // GAME_STATE UTXO.
    //
    // Timeout claims (currently sketched as `isTimeoutMove(move)` with
    // an opponent-signed branch) are deferred until they get their own
    // verifier-params slot or generator-side signer dispatch; with the
    // signature gate first there's no way to honor them in the same
    // entry point. See TODO.md.
    env.sign(mover);

    // Pull the user move from RECORD/"move". requestBody consumes one slot in
    // the RECORD namespace (positionally first).
    const moveSlot = await env.request({
      contract: RECORD_CONTRACT,
      params: MOVE_KEY,
    });
    let move: Move;
    try {
      move = decodeMove(moveSlot.body);
    } catch (e) {
      throw new ContractRejection('move malformed: ' + (e as Error).message);
    }

    if (isTimeoutMove(move)) {
      throw new ContractRejection(
        'timeout-move publishing temporarily disabled (needs separate signer-dispatched entry)',
      );
    }

    if (now <= prev.state.lastMoveAt) {
      throw new ContractRejection('block timestamp must be strictly after prev move');
    }

    let next;
    try {
      next = applyMove(prev.state, move, now);
    } catch (e) {
      throw new ContractRejection('illegal move: ' + (e as Error).message);
    }

    const pot = prevInput.value;

    if (isTerminalStatus(next.status)) {
      // Pay winners. SIGNATURE_CONTRACT is unowned -- change outputs from
      // auto-balance can coexist without violating partition.
      const white = prev.white;
      const black = prev.black;
      switch (next.status) {
        case STATUS_WHITE_WON:
        case STATUS_TIMEOUT_BLACK:
          env.send(
            { contract: SIGNATURE_CONTRACT, params: white },
            pot,
          );
          break;
        case STATUS_BLACK_WON:
        case STATUS_TIMEOUT_WHITE:
          env.send(
            { contract: SIGNATURE_CONTRACT, params: black },
            pot,
          );
          break;
        case STATUS_DRAW: {
          const half = Math.floor(pot / 2);
          env.send(
            { contract: SIGNATURE_CONTRACT, params: white },
            half,
          );
          env.send(
            { contract: SIGNATURE_CONTRACT, params: black },
            pot - half,
          );
          break;
        }
        default:
          throw new ContractRejection('unexpected terminal status');
      }
      return;
    }

    // Non-terminal: produce the next GAME_STATE output. Value = pot (unchanged).
    const nextEnv: GameStateEnvelope = {
      state: next,
      white: prev.white,
      black: prev.black,
    };
    env.send(
      { contract: GAME_STATE_CONTRACT, params: nextParamsBytes },
      pot,
      encodeGameState(nextEnv),
    );
  },
};
