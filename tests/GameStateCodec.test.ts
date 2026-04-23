import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  decodeGameParams,
  decodeGameState,
  decodeMove,
  encodeGameParams,
  encodeGameState,
  encodeMove,
  GAME_ID_BYTES,
  GAME_PARAMS_BYTES,
  GAME_STATE_BYTES,
  isAwaitingJoin,
  makeGameId,
  MOVE_BYTES,
  ZERO_PUBKEY,
} from '../src/demo/chess/GameStateCodec.ts';
import { makeAwaitingJoinState, makeInProgressState } from '../src/demo/chess/ChessRules.ts';

function pubkey(byte: number): Uint8Array {
  const out = new Uint8Array(33);
  out.fill(byte);
  return out;
}

Deno.test('move round-trip', () => {
  const m = { from: 12, to: 28, promotion: 0 };
  const bytes = encodeMove(m);
  assertEquals(bytes.length, MOVE_BYTES);
  assertEquals(decodeMove(bytes), m);
});

Deno.test('move rejects wrong length', () => {
  assertThrows(() => decodeMove(new Uint8Array(2)));
  assertThrows(() => decodeMove(new Uint8Array(4)));
});

Deno.test('gameState round-trip in-progress', () => {
  const env = {
    state: makeInProgressState(1_700_000_000_000),
    white: pubkey(0xaa),
    black: pubkey(0xbb),
  };
  const bytes = encodeGameState(env);
  assertEquals(bytes.length, GAME_STATE_BYTES);
  const decoded = decodeGameState(bytes);
  assertEquals(decoded.state.board, env.state.board);
  assertEquals(decoded.state.toMove, env.state.toMove);
  assertEquals(decoded.state.castling, env.state.castling);
  assertEquals(decoded.state.enPassant, env.state.enPassant);
  assertEquals(decoded.state.status, env.state.status);
  assertEquals(decoded.state.halfmoveClock, env.state.halfmoveClock);
  assertEquals(decoded.state.fullmove, env.state.fullmove);
  assertEquals(decoded.state.whiteClockMs, env.state.whiteClockMs);
  assertEquals(decoded.state.blackClockMs, env.state.blackClockMs);
  assertEquals(decoded.state.lastMoveAt, env.state.lastMoveAt);
  assertEquals(decoded.white, env.white);
  assertEquals(decoded.black, env.black);
});

Deno.test('gameState preserves lastMoveAt past 2^32', () => {
  const ts = 2 ** 40;
  const env = {
    state: makeInProgressState(ts),
    white: pubkey(1),
    black: pubkey(2),
  };
  const decoded = decodeGameState(encodeGameState(env));
  assertEquals(decoded.state.lastMoveAt, ts);
});

Deno.test('awaiting-join envelope has zero black pubkey', () => {
  const env = {
    state: makeAwaitingJoinState(0),
    white: pubkey(0x11),
    black: ZERO_PUBKEY,
  };
  const decoded = decodeGameState(encodeGameState(env));
  assert(isAwaitingJoin(decoded));
});

Deno.test('gameState rejects malformed input', () => {
  assertThrows(() => decodeGameState(new Uint8Array(10)));
});

Deno.test('game params round-trip', () => {
  const id = new Uint8Array(GAME_ID_BYTES);
  for (let i = 0; i < id.length; i++) id[i] = i;
  const bytes = encodeGameParams(id, 42);
  assertEquals(bytes.length, GAME_PARAMS_BYTES);
  const decoded = decodeGameParams(bytes);
  assertEquals(decoded.gameId, id);
  assertEquals(decoded.turnId, 42);
});

Deno.test('makeGameId is deterministic given same creator+nonce', () => {
  const creator = pubkey(0x42);
  const nonce = new Uint8Array(GAME_ID_BYTES);
  for (let i = 0; i < nonce.length; i++) nonce[i] = 0x10 + i;
  const a = makeGameId(creator, nonce);
  const b = makeGameId(creator, nonce);
  assertEquals(a, b);
  assertEquals(a.length, GAME_ID_BYTES);
});
