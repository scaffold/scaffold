import { assertEquals, assertThrows } from '@std/assert';
import {
  decodeAction,
  decodeSeed,
  decodeState,
  encodeAction,
  encodeSeed,
  encodeState,
  matchId,
} from '../../../src/contract/static/chess/ChessCodec.ts';
import {
  applyMove,
  initialGameState,
  sqIdx,
} from '../../../src/contract/static/chess/ChessRules.ts';
import { bin2str, str2bin } from '../../../src/util/buffer.ts';

const MATCH = 'ab'.repeat(32);
const WHITE_KEY = '02' + '11'.repeat(32);
const BLACK_KEY = '03' + '22'.repeat(32);

function reencode(mutate: (state: Record<string, unknown>) => void): Uint8Array {
  const encoded = JSON.parse(bin2str(encodeState({
    game: initialGameState(),
    white: WHITE_KEY,
    black: BLACK_KEY,
  })));
  mutate(encoded);
  return str2bin(JSON.stringify(encoded));
}

Deno.test('a match id passes through validation unchanged', () => {
  assertEquals(matchId(MATCH), MATCH);
});

Deno.test('a match id that is not 32 hex bytes is rejected', () => {
  assertThrows(() => matchId('abcd'));
});

Deno.test('a params slot that is missing entirely is not a match id', () => {
  assertThrows(() => matchId(undefined));
});

Deno.test('seed round-trip', () => {
  const seed = { white: WHITE_KEY, black: BLACK_KEY };
  assertEquals(decodeSeed(encodeSeed(seed)), seed);
});

Deno.test('a seed naming the same player twice is rejected', () => {
  assertThrows(() => decodeSeed(encodeSeed({ white: WHITE_KEY, black: WHITE_KEY })));
});

Deno.test('a seed that is not JSON is rejected', () => {
  assertThrows(() => decodeSeed(str2bin('not json')));
});

Deno.test('a move action round-trips', () => {
  const action = {
    type: 'move' as const,
    move: { from: sqIdx('e2'), to: sqIdx('e4'), promotion: 0 },
  };
  assertEquals(decodeAction(encodeAction(action)), action);
});

Deno.test('a timeout action round-trips', () => {
  assertEquals(decodeAction(encodeAction({ type: 'timeout' })), { type: 'timeout' });
});

Deno.test('an action of an unknown type is rejected', () => {
  assertThrows(() => decodeAction(str2bin(JSON.stringify({ type: 'resign' }))));
});

Deno.test('a move off the board is rejected', () => {
  assertThrows(() =>
    decodeAction(str2bin(JSON.stringify({ type: 'move', from: 0, to: 64, promotion: 0 })))
  );
});

Deno.test('state round-trips through a played move', () => {
  const state = {
    game: applyMove(initialGameState(), { from: sqIdx('e2'), to: sqIdx('e4'), promotion: 0 }),
    white: WHITE_KEY,
    black: BLACK_KEY,
  };
  const decoded = decodeState(encodeState(state));
  assertEquals(decoded, state);
  assertEquals(encodeState(decoded), encodeState(state));
});

Deno.test('a board with the wrong number of squares is rejected', () => {
  assertThrows(() => decodeState(reencode((s) => s.board = (s.board as number[]).slice(0, 63))));
});

Deno.test('a square holding an unknown piece code is rejected', () => {
  assertThrows(() => decodeState(reencode((s) => (s.board as number[])[0] = 13)));
});

Deno.test('an en passant target that is neither a square nor the empty sentinel is rejected', () => {
  assertThrows(() => decodeState(reencode((s) => s.enPassant = 100)));
});

Deno.test('a state naming a player that is not a public key is rejected', () => {
  assertThrows(() => decodeState(reencode((s) => s.black = 'ff')));
});
