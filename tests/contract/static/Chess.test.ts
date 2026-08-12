import { assertEquals, assertNotEquals } from '@std/assert';
import {
  CHESS_MOVE,
  CHESS_NEW,
  chessContract,
  chessPredicate,
} from '../../../src/contract/static/Chess.ts';
import { ParamsReader } from '../../../src/contract/env/util/params.ts';
import { createSink } from '../../../src/contract/createSink.ts';
import { createSource } from '../../../src/contract/createSource.ts';
import {
  encodeAction,
  encodeSeed,
  encodeState,
} from '../../../src/contract/static/chess/ChessCodec.ts';
import { initialGameState } from '../../../src/contract/static/chess/ChessRules.ts';

const MATCH = 'ab'.repeat(32);
const OTHER_MATCH = 'cd'.repeat(32);

const read = (params: Uint8Array) =>
  new ParamsReader({ params: (truncate) => params.subarray(0, truncate) });

Deno.test('a match predicate carries its mode and match id as params slots', () => {
  const reader = read(chessPredicate(CHESS_MOVE, MATCH).params);
  assertEquals(reader.read(0), CHESS_MOVE);
  assertEquals(reader.read(1), MATCH);
  assertEquals(reader.read(2), undefined);
});

Deno.test('opening a match and playing it are separate predicates', () => {
  assertNotEquals(
    chessPredicate(CHESS_NEW, MATCH).params,
    chessPredicate(CHESS_MOVE, MATCH).params,
  );
});

Deno.test('two matches name two different outputs', () => {
  assertNotEquals(
    chessPredicate(CHESS_MOVE, MATCH).params,
    chessPredicate(CHESS_MOVE, OTHER_MATCH).params,
  );
});

Deno.test('params built from a structured source match the encoded predicate', async () => {
  const built = await chessContract.buildParams!(() =>
    createSource({ mode: CHESS_MOVE, match: MATCH })
  );
  assertEquals(built, chessPredicate(CHESS_MOVE, MATCH).params);
});

Deno.test('walking params exposes the mode and match id', async () => {
  const walked = await createSink((sink) =>
    chessContract.walkParams!(chessPredicate(CHESS_NEW, MATCH).params, sink)
  );
  assertEquals(walked, { mode: CHESS_NEW, match: MATCH });
});

// Both body codecs need a way to tell a state, a seed and an action apart.
Deno.test({
  name: 'an action body round-trips through its move',
  ignore: true,
  fn: async () => {
    const move = { type: 'move', from: 12, to: 28, promotion: 0 };
    const built = await chessContract.buildBody!(() => createSource(move));
    assertEquals(built, encodeAction({ type: 'move', move: { from: 12, to: 28, promotion: 0 } }));
    assertEquals(await createSink((sink) => chessContract.walkBody!(built, sink)), move);
  },
});

Deno.test({
  name: 'a seed body round-trips through both players',
  ignore: true,
  fn: async () => {
    const seed = { white: 'aa'.repeat(33), black: 'bb'.repeat(33) };
    const built = await chessContract.buildBody!(() => createSource(seed));
    assertEquals(built, encodeSeed(seed));
    assertEquals(await createSink((sink) => chessContract.walkBody!(built, sink)), seed);
  },
});

Deno.test({
  name: 'a state body walks its game and its players',
  ignore: true,
  fn: async () => {
    const state = { game: initialGameState(), white: 'aa'.repeat(33), black: 'bb'.repeat(33) };
    const walked = await createSink((sink) =>
      chessContract.walkBody!(encodeState(state), sink)
    ) as { toMove: number; white: string };
    assertEquals(walked.toMove, state.game.toMove);
    assertEquals(walked.white, state.white);
  },
});

Deno.test('debug names the mode and the head of the match id', () => {
  assertEquals(
    chessContract.debug!(chessPredicate(CHESS_MOVE, MATCH).params, undefined!),
    'chess(move:abababab)',
  );
});

Deno.test('debug does not throw on params that are not a chess predicate', () => {
  assertEquals(chessContract.debug!(new Uint8Array([1, 2, 3]), undefined!), 'chess(malformed)');
});
