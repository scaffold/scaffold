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

Deno.test('debug names the mode and the head of the match id', () => {
  assertEquals(
    chessContract.debug!(chessPredicate(CHESS_MOVE, MATCH).params, undefined!),
    'chess(move:abababab)',
  );
});

Deno.test('debug does not throw on params that are not a chess predicate', () => {
  assertEquals(chessContract.debug!(new Uint8Array([1, 2, 3]), undefined!), 'chess(malformed)');
});
