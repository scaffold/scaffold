// Pure chess rules, ported from legacy3/demo/chess/ChessRules.ts. No Scaffold dependencies, so
// the generator and the verifier share exactly the same code. Clocks and timeout claims were
// dropped in the port: they need a block timestamp, which `ContractEnv` does not expose.

export const EMPTY = 0;
export const W_PAWN = 1;
export const W_KNIGHT = 2;
export const W_BISHOP = 3;
export const W_ROOK = 4;
export const W_QUEEN = 5;
export const W_KING = 6;
export const B_PAWN = 7;
export const B_KNIGHT = 8;
export const B_BISHOP = 9;
export const B_ROOK = 10;
export const B_QUEEN = 11;
export const B_KING = 12;

export type Piece = number;

export const WHITE = 0;
export const BLACK = 1;
export type Color = 0 | 1;

// Castling rights bit field.
export const CASTLE_WK = 0b1000;
export const CASTLE_WQ = 0b0100;
export const CASTLE_BK = 0b0010;
export const CASTLE_BQ = 0b0001;
export const CASTLE_ALL = CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ;

export const EP_NONE = 0xff;

export const STATUS_IN_PROGRESS = 0;
export const STATUS_WHITE_WON = 1;
export const STATUS_BLACK_WON = 2;
export const STATUS_DRAW = 3;

export type Status =
  | typeof STATUS_IN_PROGRESS
  | typeof STATUS_WHITE_WON
  | typeof STATUS_BLACK_WON
  | typeof STATUS_DRAW;

// `board` is 64 bytes indexed rank * 8 + file, rank 0 is white's back rank and file 0 the a-file.
export interface GameState {
  board: Uint8Array;
  toMove: Color;
  castling: number;
  enPassant: number;
  halfmoveClock: number;
  fullmove: number;
  status: Status;
}

export interface Move {
  from: number;
  to: number;
  // White or black piece code; 0 for a move that does not promote.
  promotion: number;
}

export function isTerminalStatus(s: Status): boolean {
  return s !== STATUS_IN_PROGRESS;
}

export function colorOf(p: Piece): Color | -1 {
  if (p >= W_PAWN && p <= W_KING) return WHITE;
  if (p >= B_PAWN && p <= B_KING) return BLACK;
  return -1;
}

export function isWhite(p: Piece): boolean {
  return p >= W_PAWN && p <= W_KING;
}

export function isBlack(p: Piece): boolean {
  return p >= B_PAWN && p <= B_KING;
}

function rankOf(square: number): number {
  return square >> 3;
}

function fileOf(square: number): number {
  return square & 7;
}

function sq(r: number, f: number): number {
  return r * 8 + f;
}

function onBoard(r: number, f: number): boolean {
  return r >= 0 && r < 8 && f >= 0 && f < 8;
}

export function initialBoard(): Uint8Array {
  const b = new Uint8Array(64);
  b[sq(0, 0)] = W_ROOK;
  b[sq(0, 1)] = W_KNIGHT;
  b[sq(0, 2)] = W_BISHOP;
  b[sq(0, 3)] = W_QUEEN;
  b[sq(0, 4)] = W_KING;
  b[sq(0, 5)] = W_BISHOP;
  b[sq(0, 6)] = W_KNIGHT;
  b[sq(0, 7)] = W_ROOK;
  for (let f = 0; f < 8; f++) b[sq(1, f)] = W_PAWN;
  b[sq(7, 0)] = B_ROOK;
  b[sq(7, 1)] = B_KNIGHT;
  b[sq(7, 2)] = B_BISHOP;
  b[sq(7, 3)] = B_QUEEN;
  b[sq(7, 4)] = B_KING;
  b[sq(7, 5)] = B_BISHOP;
  b[sq(7, 6)] = B_KNIGHT;
  b[sq(7, 7)] = B_ROOK;
  for (let f = 0; f < 8; f++) b[sq(6, f)] = B_PAWN;
  return b;
}

export function initialGameState(): GameState {
  return {
    board: initialBoard(),
    toMove: WHITE,
    castling: CASTLE_ALL,
    enPassant: EP_NONE,
    halfmoveClock: 0,
    fullmove: 1,
    status: STATUS_IN_PROGRESS,
  };
}

export function cloneState(s: GameState): GameState {
  return {
    board: new Uint8Array(s.board),
    toMove: s.toMove,
    castling: s.castling,
    enPassant: s.enPassant,
    halfmoveClock: s.halfmoveClock,
    fullmove: s.fullmove,
    status: s.status,
  };
}

const KNIGHT_OFFSETS: [number, number][] = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];

const KING_OFFSETS: [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

const BISHOP_DIRS: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ROOK_DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const QUEEN_DIRS: [number, number][] = [...BISHOP_DIRS, ...ROOK_DIRS];

export function isSquareAttacked(board: Uint8Array, target: number, byColor: Color): boolean {
  const tr = rankOf(target);
  const tf = fileOf(target);

  if (byColor === WHITE) {
    if (tr - 1 >= 0) {
      if (tf - 1 >= 0 && board[sq(tr - 1, tf - 1)] === W_PAWN) return true;
      if (tf + 1 < 8 && board[sq(tr - 1, tf + 1)] === W_PAWN) return true;
    }
  } else {
    if (tr + 1 < 8) {
      if (tf - 1 >= 0 && board[sq(tr + 1, tf - 1)] === B_PAWN) return true;
      if (tf + 1 < 8 && board[sq(tr + 1, tf + 1)] === B_PAWN) return true;
    }
  }

  const knight = byColor === WHITE ? W_KNIGHT : B_KNIGHT;
  for (const [dr, df] of KNIGHT_OFFSETS) {
    const r = tr + dr;
    const f = tf + df;
    if (onBoard(r, f) && board[sq(r, f)] === knight) return true;
  }

  const king = byColor === WHITE ? W_KING : B_KING;
  for (const [dr, df] of KING_OFFSETS) {
    const r = tr + dr;
    const f = tf + df;
    if (onBoard(r, f) && board[sq(r, f)] === king) return true;
  }

  const bishop = byColor === WHITE ? W_BISHOP : B_BISHOP;
  const queen = byColor === WHITE ? W_QUEEN : B_QUEEN;
  for (const [dr, df] of BISHOP_DIRS) {
    let r = tr + dr;
    let f = tf + df;
    while (onBoard(r, f)) {
      const p = board[sq(r, f)];
      if (p !== EMPTY) {
        if (p === bishop || p === queen) return true;
        break;
      }
      r += dr;
      f += df;
    }
  }

  const rook = byColor === WHITE ? W_ROOK : B_ROOK;
  for (const [dr, df] of ROOK_DIRS) {
    let r = tr + dr;
    let f = tf + df;
    while (onBoard(r, f)) {
      const p = board[sq(r, f)];
      if (p !== EMPTY) {
        if (p === rook || p === queen) return true;
        break;
      }
      r += dr;
      f += df;
    }
  }

  return false;
}

export function findKing(board: Uint8Array, color: Color): number {
  const king = color === WHITE ? W_KING : B_KING;
  for (let i = 0; i < 64; i++) if (board[i] === king) return i;
  return -1;
}

export function isInCheck(board: Uint8Array, color: Color): boolean {
  const king = findKing(board, color);
  if (king < 0) return false;
  return isSquareAttacked(board, king, (1 - color) as Color);
}

// The discriminators are what `applyGenerated` needs to update flags; they are not part of a Move.
interface Generated {
  from: number;
  to: number;
  promotion: number;
  isEnPassant: boolean;
  isDoublePush: boolean;
  isCastleKing: boolean;
  isCastleQueen: boolean;
}

function generated(
  from: number,
  to: number,
  promotion: number,
  flags?: Partial<Generated>,
): Generated {
  return {
    from,
    to,
    promotion,
    isEnPassant: false,
    isDoublePush: false,
    isCastleKing: false,
    isCastleQueen: false,
    ...flags,
  };
}

function genPawn(state: GameState, from: number, out: Generated[]): void {
  const b = state.board;
  const mover = state.toMove;
  const r = rankOf(from);
  const f = fileOf(from);
  const dir = mover === WHITE ? 1 : -1;
  const startRank = mover === WHITE ? 1 : 6;
  const promoRank = mover === WHITE ? 7 : 0;
  const enemyLo = mover === WHITE ? B_PAWN : W_PAWN;
  const enemyHi = mover === WHITE ? B_KING : W_KING;
  const baseKnight = mover === WHITE ? W_KNIGHT : B_KNIGHT;
  const baseQueen = mover === WHITE ? W_QUEEN : B_QUEEN;

  const push1 = sq(r + dir, f);
  if (onBoard(r + dir, f) && b[push1] === EMPTY) {
    if (r + dir === promoRank) {
      for (let p = baseKnight; p <= baseQueen; p++) out.push(generated(from, push1, p));
    } else {
      out.push(generated(from, push1, 0));
      if (r === startRank) {
        const push2 = sq(r + 2 * dir, f);
        if (b[push2] === EMPTY) {
          out.push(generated(from, push2, 0, { isDoublePush: true }));
        }
      }
    }
  }

  for (const df of [-1, 1]) {
    const nr = r + dir;
    const nf = f + df;
    if (!onBoard(nr, nf)) continue;
    const to = sq(nr, nf);
    const target = b[to];
    const isEnPassant = to === state.enPassant && target === EMPTY;
    if (!isEnPassant && (target === EMPTY || target < enemyLo || target > enemyHi)) continue;
    if (nr === promoRank) {
      for (let p = baseKnight; p <= baseQueen; p++) out.push(generated(from, to, p));
    } else {
      out.push(generated(from, to, 0, { isEnPassant }));
    }
  }
}

function genJumper(
  state: GameState,
  from: number,
  offsets: [number, number][],
  out: Generated[],
): void {
  const b = state.board;
  const mover = state.toMove;
  const r = rankOf(from);
  const f = fileOf(from);
  const friendlyLo = mover === WHITE ? W_PAWN : B_PAWN;
  const friendlyHi = mover === WHITE ? W_KING : B_KING;
  for (const [dr, df] of offsets) {
    const nr = r + dr;
    const nf = f + df;
    if (!onBoard(nr, nf)) continue;
    const to = sq(nr, nf);
    const target = b[to];
    if (target >= friendlyLo && target <= friendlyHi) continue;
    out.push(generated(from, to, 0));
  }
}

function genSlider(
  state: GameState,
  from: number,
  dirs: [number, number][],
  out: Generated[],
): void {
  const b = state.board;
  const mover = state.toMove;
  const r = rankOf(from);
  const f = fileOf(from);
  const friendlyLo = mover === WHITE ? W_PAWN : B_PAWN;
  const friendlyHi = mover === WHITE ? W_KING : B_KING;
  for (const [dr, df] of dirs) {
    let nr = r + dr;
    let nf = f + df;
    while (onBoard(nr, nf)) {
      const to = sq(nr, nf);
      const target = b[to];
      if (target === EMPTY) {
        out.push(generated(from, to, 0));
      } else {
        if (!(target >= friendlyLo && target <= friendlyHi)) out.push(generated(from, to, 0));
        break;
      }
      nr += dr;
      nf += df;
    }
  }
}

function genCastles(state: GameState, out: Generated[]): void {
  const b = state.board;
  const mover = state.toMove;
  const opp = (1 - mover) as Color;
  if (isInCheck(b, mover)) return;
  if (mover === WHITE) {
    if (
      state.castling & CASTLE_WK &&
      b[sq(0, 5)] === EMPTY && b[sq(0, 6)] === EMPTY && b[sq(0, 4)] === W_KING &&
      b[sq(0, 7)] === W_ROOK &&
      !isSquareAttacked(b, sq(0, 5), opp) && !isSquareAttacked(b, sq(0, 6), opp)
    ) {
      out.push(generated(sq(0, 4), sq(0, 6), 0, { isCastleKing: true }));
    }
    if (
      state.castling & CASTLE_WQ &&
      b[sq(0, 1)] === EMPTY && b[sq(0, 2)] === EMPTY && b[sq(0, 3)] === EMPTY &&
      b[sq(0, 4)] === W_KING && b[sq(0, 0)] === W_ROOK &&
      !isSquareAttacked(b, sq(0, 3), opp) && !isSquareAttacked(b, sq(0, 2), opp)
    ) {
      out.push(generated(sq(0, 4), sq(0, 2), 0, { isCastleQueen: true }));
    }
  } else {
    if (
      state.castling & CASTLE_BK &&
      b[sq(7, 5)] === EMPTY && b[sq(7, 6)] === EMPTY && b[sq(7, 4)] === B_KING &&
      b[sq(7, 7)] === B_ROOK &&
      !isSquareAttacked(b, sq(7, 5), opp) && !isSquareAttacked(b, sq(7, 6), opp)
    ) {
      out.push(generated(sq(7, 4), sq(7, 6), 0, { isCastleKing: true }));
    }
    if (
      state.castling & CASTLE_BQ &&
      b[sq(7, 1)] === EMPTY && b[sq(7, 2)] === EMPTY && b[sq(7, 3)] === EMPTY &&
      b[sq(7, 4)] === B_KING && b[sq(7, 0)] === B_ROOK &&
      !isSquareAttacked(b, sq(7, 3), opp) && !isSquareAttacked(b, sq(7, 2), opp)
    ) {
      out.push(generated(sq(7, 4), sq(7, 2), 0, { isCastleQueen: true }));
    }
  }
}

function generatePseudoMoves(state: GameState): Generated[] {
  const out: Generated[] = [];
  const mover = state.toMove;
  const friendlyLo = mover === WHITE ? W_PAWN : B_PAWN;
  const friendlyHi = mover === WHITE ? W_KING : B_KING;
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (p < friendlyLo || p > friendlyHi) continue;
    switch (p) {
      case W_PAWN:
      case B_PAWN:
        genPawn(state, i, out);
        break;
      case W_KNIGHT:
      case B_KNIGHT:
        genJumper(state, i, KNIGHT_OFFSETS, out);
        break;
      case W_BISHOP:
      case B_BISHOP:
        genSlider(state, i, BISHOP_DIRS, out);
        break;
      case W_ROOK:
      case B_ROOK:
        genSlider(state, i, ROOK_DIRS, out);
        break;
      case W_QUEEN:
      case B_QUEEN:
        genSlider(state, i, QUEEN_DIRS, out);
        break;
      case W_KING:
      case B_KING:
        genJumper(state, i, KING_OFFSETS, out);
        break;
    }
  }
  genCastles(state, out);
  return out;
}

function applyGenerated(state: GameState, g: Generated): GameState {
  const next = cloneState(state);
  const b = next.board;
  const piece = b[g.from];
  const target = b[g.to];

  b[g.from] = EMPTY;
  b[g.to] = g.promotion !== 0 ? g.promotion : piece;

  if (g.isEnPassant) {
    const capR = state.toMove === WHITE ? rankOf(g.to) - 1 : rankOf(g.to) + 1;
    b[sq(capR, fileOf(g.to))] = EMPTY;
  }

  if (g.isCastleKing) {
    if (state.toMove === WHITE) {
      b[sq(0, 7)] = EMPTY;
      b[sq(0, 5)] = W_ROOK;
    } else {
      b[sq(7, 7)] = EMPTY;
      b[sq(7, 5)] = B_ROOK;
    }
  } else if (g.isCastleQueen) {
    if (state.toMove === WHITE) {
      b[sq(0, 0)] = EMPTY;
      b[sq(0, 3)] = W_ROOK;
    } else {
      b[sq(7, 0)] = EMPTY;
      b[sq(7, 3)] = B_ROOK;
    }
  }

  if (piece === W_KING) next.castling &= ~(CASTLE_WK | CASTLE_WQ);
  if (piece === B_KING) next.castling &= ~(CASTLE_BK | CASTLE_BQ);
  if (piece === W_ROOK) {
    if (g.from === sq(0, 0)) next.castling &= ~CASTLE_WQ;
    if (g.from === sq(0, 7)) next.castling &= ~CASTLE_WK;
  }
  if (piece === B_ROOK) {
    if (g.from === sq(7, 0)) next.castling &= ~CASTLE_BQ;
    if (g.from === sq(7, 7)) next.castling &= ~CASTLE_BK;
  }
  // Capturing a rook on its original square also removes the corresponding right.
  if (g.to === sq(0, 0)) next.castling &= ~CASTLE_WQ;
  if (g.to === sq(0, 7)) next.castling &= ~CASTLE_WK;
  if (g.to === sq(7, 0)) next.castling &= ~CASTLE_BQ;
  if (g.to === sq(7, 7)) next.castling &= ~CASTLE_BK;

  if (g.isDoublePush) {
    const mid = state.toMove === WHITE ? rankOf(g.from) + 1 : rankOf(g.from) - 1;
    next.enPassant = sq(mid, fileOf(g.from));
  } else {
    next.enPassant = EP_NONE;
  }

  const isPawn = piece === W_PAWN || piece === B_PAWN;
  const isCapture = target !== EMPTY || g.isEnPassant;
  next.halfmoveClock = isPawn || isCapture ? 0 : next.halfmoveClock + 1;

  if (state.toMove === BLACK) next.fullmove++;

  next.toMove = (1 - state.toMove) as Color;
  return next;
}

export function legalMoves(state: GameState): Move[] {
  const legal: Move[] = [];
  for (const g of generatePseudoMoves(state)) {
    const next = applyGenerated(state, g);
    if (isInCheck(next.board, state.toMove)) continue;
    legal.push({ from: g.from, to: g.to, promotion: g.promotion });
  }
  return legal;
}

function matchPseudo(state: GameState, m: Move): Generated | undefined {
  return generatePseudoMoves(state).find(
    (g) => g.from === m.from && g.to === m.to && g.promotion === m.promotion,
  );
}

// Throws on any move the position does not allow. Callers own authorization: the rules do not
// know which player published the move.
export function applyMove(prev: GameState, move: Move): GameState {
  if (prev.status !== STATUS_IN_PROGRESS) throw new Error('game is not in progress');

  const g = matchPseudo(prev, move);
  if (!g) throw new Error('illegal move (piece cannot move that way)');

  const next = applyGenerated(prev, g);
  if (isInCheck(next.board, prev.toMove)) {
    throw new Error('illegal move (leaves own king in check)');
  }

  if (legalMoves(next).length > 0) {
    next.status = STATUS_IN_PROGRESS;
  } else if (isInCheck(next.board, next.toMove)) {
    next.status = prev.toMove === WHITE ? STATUS_WHITE_WON : STATUS_BLACK_WON;
  } else {
    next.status = STATUS_DRAW;
  }

  return next;
}

export function isCheckmate(state: GameState): boolean {
  return isInCheck(state.board, state.toMove) && legalMoves(state).length === 0;
}

export function isStalemate(state: GameState): boolean {
  return !isInCheck(state.board, state.toMove) && legalMoves(state).length === 0;
}

export function sqIdx(s: string): number {
  if (s.length !== 2) throw new Error('bad square');
  const f = s.charCodeAt(0) - 'a'.charCodeAt(0);
  const r = s.charCodeAt(1) - '1'.charCodeAt(0);
  if (f < 0 || f > 7 || r < 0 || r > 7) throw new Error('bad square');
  return r * 8 + f;
}

export function sqName(i: number): string {
  return String.fromCharCode('a'.charCodeAt(0) + fileOf(i)) +
    String.fromCharCode('1'.charCodeAt(0) + rankOf(i));
}
