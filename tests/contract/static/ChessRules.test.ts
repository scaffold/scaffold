import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  applyMove,
  B_KING,
  B_PAWN,
  B_QUEEN,
  B_ROOK,
  CASTLE_ALL,
  CASTLE_WK,
  CASTLE_WQ,
  EMPTY,
  EP_NONE,
  type GameState,
  initialBoard,
  initialGameState,
  isCheckmate,
  isInCheck,
  isSquareAttacked,
  isStalemate,
  legalMoves,
  type Move,
  sqIdx,
  STATUS_BLACK_WON,
  STATUS_DRAW,
  STATUS_IN_PROGRESS,
  W_KING,
  W_PAWN,
  W_QUEEN,
  W_ROOK,
  WHITE,
} from '../../../src/contract/static/chess/ChessRules.ts';

function mv(from: string, to: string, promotion = 0): Move {
  return { from: sqIdx(from), to: sqIdx(to), promotion };
}

function emptyState(): GameState {
  return {
    board: new Uint8Array(64),
    toMove: WHITE,
    castling: 0,
    enPassant: EP_NONE,
    halfmoveClock: 0,
    fullmove: 1,
    status: STATUS_IN_PROGRESS,
  };
}

Deno.test('the initial board carries the standard piece layout', () => {
  const b = initialBoard();
  assertEquals(b[sqIdx('a1')], W_ROOK);
  assertEquals(b[sqIdx('e1')], W_KING);
  assertEquals(b[sqIdx('d8')], B_QUEEN);
  assertEquals(b[sqIdx('e2')], W_PAWN);
  assertEquals(b[sqIdx('e7')], B_PAWN);
  assertEquals(b[sqIdx('e4')], EMPTY);
});

Deno.test('a double pawn push moves the pawn, sets en passant and passes the turn', () => {
  const next = applyMove(initialGameState(), mv('e2', 'e4'));
  assertEquals(next.board[sqIdx('e4')], W_PAWN);
  assertEquals(next.board[sqIdx('e2')], EMPTY);
  assertEquals(next.enPassant, sqIdx('e3'));
  assertEquals(next.toMove, 1);
  assertEquals(next.status, STATUS_IN_PROGRESS);
});

Deno.test('a bishop cannot move through its own pawn', () => {
  assertThrows(() => applyMove(initialGameState(), mv('c1', 'h6')));
});

Deno.test('a rook boxed in on the first rank cannot move', () => {
  assertThrows(() => applyMove(initialGameState(), mv('a1', 'a3')));
});

Deno.test('a move that exposes the mover to check is rejected', () => {
  const s = emptyState();
  s.board[sqIdx('e1')] = W_KING;
  s.board[sqIdx('e2')] = W_QUEEN;
  s.board[sqIdx('e8')] = B_ROOK;
  s.board[sqIdx('a8')] = B_KING;
  assertThrows(() => applyMove(s, mv('e2', 'a2')));
});

Deno.test('an en passant capture removes the pawn that just double-pushed', () => {
  const s = emptyState();
  s.board[sqIdx('e5')] = W_PAWN;
  s.board[sqIdx('d7')] = B_PAWN;
  s.board[sqIdx('a1')] = W_KING;
  s.board[sqIdx('h8')] = B_KING;
  s.toMove = 1;

  const pushed = applyMove(s, mv('d7', 'd5'));
  assertEquals(pushed.enPassant, sqIdx('d6'));
  assertEquals(pushed.toMove, 0);

  const captured = applyMove(pushed, mv('e5', 'd6'));
  assertEquals(captured.board[sqIdx('d6')], W_PAWN);
  assertEquals(captured.board[sqIdx('d5')], EMPTY);
  assertEquals(captured.board[sqIdx('e5')], EMPTY);
});

Deno.test('a pawn reaching the last rank becomes the promoted piece', () => {
  const s = emptyState();
  s.board[sqIdx('a7')] = W_PAWN;
  s.board[sqIdx('e1')] = W_KING;
  s.board[sqIdx('h8')] = B_KING;
  const next = applyMove(s, mv('a7', 'a8', W_QUEEN));
  assertEquals(next.board[sqIdx('a8')], W_QUEEN);
});

Deno.test('castling kingside moves the rook and drops both castling rights', () => {
  const s = emptyState();
  s.board[sqIdx('e1')] = W_KING;
  s.board[sqIdx('h1')] = W_ROOK;
  s.board[sqIdx('e8')] = B_KING;
  s.castling = CASTLE_ALL;

  const next = applyMove(s, mv('e1', 'g1'));
  assertEquals(next.board[sqIdx('g1')], W_KING);
  assertEquals(next.board[sqIdx('f1')], W_ROOK);
  assertEquals(next.board[sqIdx('e1')], EMPTY);
  assertEquals(next.board[sqIdx('h1')], EMPTY);
  assertEquals(next.castling & (CASTLE_WK | CASTLE_WQ), 0);
});

Deno.test('castling through an attacked square is rejected', () => {
  const s = emptyState();
  s.board[sqIdx('e1')] = W_KING;
  s.board[sqIdx('h1')] = W_ROOK;
  s.board[sqIdx('e8')] = B_KING;
  s.board[sqIdx('f8')] = B_ROOK;
  s.castling = CASTLE_WK;
  assertThrows(() => applyMove(s, mv('e1', 'g1')));
});

Deno.test('checkmate ends the game in favour of the mating side', () => {
  let s = initialGameState();
  s = applyMove(s, mv('f2', 'f3'));
  s = applyMove(s, mv('e7', 'e5'));
  s = applyMove(s, mv('g2', 'g4'));
  s = applyMove(s, mv('d8', 'h4'));
  assertEquals(s.status, STATUS_BLACK_WON);
  assert(isCheckmate({ ...s, toMove: 0 }));
});

Deno.test('a move leaving the opponent without a legal reply but not in check is a draw', () => {
  const stalemated = emptyState();
  stalemated.board[sqIdx('h8')] = B_KING;
  stalemated.board[sqIdx('f7')] = W_KING;
  stalemated.board[sqIdx('g6')] = W_QUEEN;
  stalemated.toMove = 1;
  assert(isStalemate(stalemated));
  assert(!isInCheck(stalemated.board, 1));

  const before = emptyState();
  before.board[sqIdx('h8')] = B_KING;
  before.board[sqIdx('f7')] = W_KING;
  before.board[sqIdx('g2')] = W_QUEEN;
  assertEquals(applyMove(before, mv('g2', 'g6')).status, STATUS_DRAW);
});

Deno.test('a finished game accepts no further moves', () => {
  const s = { ...initialGameState(), status: STATUS_DRAW } as GameState;
  assertThrows(() => applyMove(s, mv('e2', 'e4')));
});

Deno.test('a pawn attacks the two squares diagonally ahead of it', () => {
  const b = new Uint8Array(64);
  b[sqIdx('e4')] = W_PAWN;
  assert(isSquareAttacked(b, sqIdx('d5'), 0));
  assert(isSquareAttacked(b, sqIdx('f5'), 0));
  assert(!isSquareAttacked(b, sqIdx('e5'), 0));
});

Deno.test('the starting position has twenty legal moves', () => {
  assertEquals(legalMoves(initialGameState()).length, 20);
});

Deno.test('both knights have two legal moves from their starting squares', () => {
  const knightMoves = legalMoves(initialGameState()).filter(
    (m) => m.from === sqIdx('b1') || m.from === sqIdx('g1'),
  );
  assertEquals(knightMoves.length, 4);
});
