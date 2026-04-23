import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  applyMove,
  B_KING,
  B_PAWN,
  B_QUEEN,
  B_ROOK,
  CASTLE_BK,
  CASTLE_BQ,
  CASTLE_WK,
  CASTLE_WQ,
  EMPTY,
  EP_NONE,
  type GameState,
  initialBoard,
  isCheckmate,
  isInCheck,
  isSquareAttacked,
  isStalemate,
  legalMoves,
  makeInProgressState,
  type Move,
  sqIdx,
  STATUS_BLACK_WON,
  STATUS_DRAW,
  STATUS_IN_PROGRESS,
  STATUS_TIMEOUT_WHITE,
  TIMEOUT_MOVE,
  W_KING,
  W_PAWN,
  W_QUEEN,
  W_ROOK,
  WHITE,
} from '../src/demo/chess/ChessRules.ts';

function mv(from: string, to: string, promotion = 0): Move {
  return { from: sqIdx(from), to: sqIdx(to), promotion };
}

function freshState(ts = 0): GameState {
  return makeInProgressState(ts);
}

function emptyState(ts = 0): GameState {
  return {
    board: new Uint8Array(64),
    toMove: WHITE,
    castling: 0,
    enPassant: EP_NONE,
    halfmoveClock: 0,
    fullmove: 1,
    whiteClockMs: 300_000,
    blackClockMs: 300_000,
    lastMoveAt: ts,
    status: STATUS_IN_PROGRESS,
  };
}

Deno.test('initial board has correct piece layout', () => {
  const b = initialBoard();
  assertEquals(b[sqIdx('a1')], W_ROOK);
  assertEquals(b[sqIdx('e1')], W_KING);
  assertEquals(b[sqIdx('d8')], B_QUEEN);
  assertEquals(b[sqIdx('e2')], W_PAWN);
  assertEquals(b[sqIdx('e7')], B_PAWN);
  assertEquals(b[sqIdx('e4')], EMPTY);
});

Deno.test('legal opening move e2-e4', () => {
  const s = freshState(1000);
  const next = applyMove(s, mv('e2', 'e4'), 1500);
  assertEquals(next.board[sqIdx('e4')], W_PAWN);
  assertEquals(next.board[sqIdx('e2')], EMPTY);
  assertEquals(next.enPassant, sqIdx('e3'));
  assertEquals(next.toMove, 1); // black
  assertEquals(next.status, STATUS_IN_PROGRESS);
  // 5s elapsed, +8s increment
  assertEquals(next.whiteClockMs, 300_000 - 500 + 8000);
  assertEquals(next.blackClockMs, 300_000);
  assertEquals(next.lastMoveAt, 1500);
});

Deno.test('illegal move: bishop through pawn', () => {
  const s = freshState(0);
  assertThrows(() => applyMove(s, mv('c1', 'h6'), 1));
});

Deno.test('illegal move: rook cannot move on turn one', () => {
  const s = freshState(0);
  assertThrows(() => applyMove(s, mv('a1', 'a3'), 1));
});

Deno.test('cannot leave own king in check', () => {
  // White king on e1, white queen on e2, black rook on e8.
  // Moving the queen anywhere off the e-file exposes the king.
  const s = emptyState(0);
  s.board[sqIdx('e1')] = W_KING;
  s.board[sqIdx('e2')] = W_QUEEN;
  s.board[sqIdx('e8')] = B_ROOK;
  s.board[sqIdx('a8')] = B_KING;
  assertThrows(() => applyMove(s, mv('e2', 'a2'), 1));
});

Deno.test('en passant capture', () => {
  // Set up: white pawn e5, black pawn d7, black to move plays d7-d5,
  // white plays exd6 e.p. next turn.
  const s = emptyState(0);
  s.board[sqIdx('e5')] = W_PAWN;
  s.board[sqIdx('d7')] = B_PAWN;
  s.board[sqIdx('a1')] = W_KING;
  s.board[sqIdx('h8')] = B_KING;
  s.toMove = 1; // black
  const after1 = applyMove(s, mv('d7', 'd5'), 1);
  assertEquals(after1.enPassant, sqIdx('d6'));
  assertEquals(after1.toMove, 0);
  const after2 = applyMove(after1, mv('e5', 'd6'), 2);
  assertEquals(after2.board[sqIdx('d6')], W_PAWN);
  assertEquals(after2.board[sqIdx('d5')], EMPTY); // captured pawn removed
  assertEquals(after2.board[sqIdx('e5')], EMPTY);
});

Deno.test('promotion to queen', () => {
  const s = emptyState(0);
  s.board[sqIdx('a7')] = W_PAWN;
  s.board[sqIdx('e1')] = W_KING;
  s.board[sqIdx('h8')] = B_KING;
  const next = applyMove(s, mv('a7', 'a8', W_QUEEN), 1);
  assertEquals(next.board[sqIdx('a8')], W_QUEEN);
});

Deno.test('kingside castling', () => {
  const s = emptyState(0);
  s.board[sqIdx('e1')] = W_KING;
  s.board[sqIdx('h1')] = W_ROOK;
  s.board[sqIdx('e8')] = B_KING;
  s.castling = CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ;
  const next = applyMove(s, mv('e1', 'g1'), 1);
  assertEquals(next.board[sqIdx('g1')], W_KING);
  assertEquals(next.board[sqIdx('f1')], W_ROOK);
  assertEquals(next.board[sqIdx('e1')], EMPTY);
  assertEquals(next.board[sqIdx('h1')], EMPTY);
  assertEquals(next.castling & (CASTLE_WK | CASTLE_WQ), 0);
});

Deno.test('cannot castle through attacked square', () => {
  const s = emptyState(0);
  s.board[sqIdx('e1')] = W_KING;
  s.board[sqIdx('h1')] = W_ROOK;
  s.board[sqIdx('e8')] = B_KING;
  s.board[sqIdx('f8')] = B_ROOK; // attacks f1
  s.castling = CASTLE_WK;
  assertThrows(() => applyMove(s, mv('e1', 'g1'), 1));
});

Deno.test('fools mate: 1.f3 e5 2.g4 Qh4# => black wins', () => {
  let s = freshState(0);
  s = applyMove(s, mv('f2', 'f3'), 1);
  s = applyMove(s, mv('e7', 'e5'), 2);
  s = applyMove(s, mv('g2', 'g4'), 3);
  s = applyMove(s, mv('d8', 'h4'), 4);
  assertEquals(s.status, STATUS_BLACK_WON);
  assert(isCheckmate({ ...s, toMove: 0 }));
});

Deno.test('stalemate => draw', () => {
  // Classic stalemate: white king a1, white queen c7, black king h8, black to move? We need
  // Black to have no legal moves and not be in check. Position: black king h8, no pieces,
  // white king f7, white queen g6. Black to move, not in check, no legal moves.
  const s = emptyState(0);
  s.board[sqIdx('h8')] = B_KING;
  s.board[sqIdx('f7')] = W_KING;
  s.board[sqIdx('g6')] = W_QUEEN;
  s.toMove = 1; // black to move
  assert(isStalemate(s));
  assert(!isInCheck(s.board, 1));

  // Now verify that a preceding white move producing this position transitions status to draw.
  // Pre-position: identical but white queen on g2, white to move, plays Qg2-g6.
  const pre = emptyState(0);
  pre.board[sqIdx('h8')] = B_KING;
  pre.board[sqIdx('f7')] = W_KING;
  pre.board[sqIdx('g2')] = W_QUEEN;
  pre.toMove = 0;
  const next = applyMove(pre, mv('g2', 'g6'), 1);
  assertEquals(next.status, STATUS_DRAW);
});

Deno.test('timeout move: valid when clock expired', () => {
  const s = freshState(0);
  // White to move at t=0. At t=300_001ms white is out of time; black can claim.
  const next = applyMove(s, TIMEOUT_MOVE, 300_001);
  assertEquals(next.status, STATUS_TIMEOUT_WHITE);
  assertEquals(next.whiteClockMs, 0);
});

Deno.test('timeout move: invalid before clock expires', () => {
  const s = freshState(0);
  assertThrows(() => applyMove(s, TIMEOUT_MOVE, 100));
});

Deno.test('normal move invalid after clock has expired', () => {
  const s = freshState(0);
  assertThrows(() => applyMove(s, mv('e2', 'e4'), 500_000));
});

Deno.test('isSquareAttacked identifies pawn attacks', () => {
  const b = new Uint8Array(64);
  b[sqIdx('e4')] = W_PAWN;
  assert(isSquareAttacked(b, sqIdx('d5'), 0));
  assert(isSquareAttacked(b, sqIdx('f5'), 0));
  assert(!isSquareAttacked(b, sqIdx('e5'), 0));
});

Deno.test('legalMoves count on starting position is 20', () => {
  const s = freshState(0);
  assertEquals(legalMoves(s).length, 20);
});

Deno.test('knight legal moves from starting squares', () => {
  const s = freshState(0);
  const knightMoves = legalMoves(s).filter((m) => m.from === sqIdx('b1') || m.from === sqIdx('g1'));
  assertEquals(knightMoves.length, 4); // Na3, Nc3, Nf3, Nh3
});
