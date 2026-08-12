// JSON codec for the chess bodies: the state an output carries, the seed that opens a match, and
// the action a block's result declares. Params are `env/util/params.ts` slot arrays, not JSON.
// Every encoder builds its object literal in one place so the bytes stay canonical.

import { bin2str, str2bin } from '../../../util/buffer.ts';
import { Color, GameState, Move, Status } from './ChessRules.ts';

// Either the move a block plays or a claim that the player to move has run out of time.
export type ChessAction =
  | { type: 'move'; move: Move }
  | { type: 'timeout' };

// The players are hex-encoded compressed secp256k1 public keys, matching SIGNATURE_CONTRACT params.
export interface ChessState {
  game: GameState;
  white: string;
  black: string;
}

export interface ChessSeed {
  white: string;
  black: string;
}

const MATCH_BYTES = 32;
const PUBLIC_KEY_BYTES = 33;

function parseObject(bytes: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bin2str(bytes));
  } catch {
    throw new Error(`chess ${what} is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`chess ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function integer(obj: Record<string, unknown>, key: string, max: number, what: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`chess ${what}.${key} must be an integer in [0, ${max}], got ${value}`);
  }
  return value;
}

function hexValue(value: unknown, length: number, what: string): string {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]*$/.test(value)) {
    throw new Error(`chess ${what} must be ${length} lowercase hex bytes, got ${value}`);
  }
  return value;
}

function hex(obj: Record<string, unknown>, key: string, length: number, what: string): string {
  return hexValue(obj[key], length, `${what}.${key}`);
}

// Validates the match id a params slot carries.
export function matchId(value: unknown): string {
  return hexValue(value, MATCH_BYTES, 'params match');
}

export function encodeSeed(seed: ChessSeed): Uint8Array {
  return str2bin(JSON.stringify({ white: seed.white, black: seed.black }));
}

export function decodeSeed(bytes: Uint8Array): ChessSeed {
  const obj = parseObject(bytes, 'seed');
  const seed = {
    white: hex(obj, 'white', PUBLIC_KEY_BYTES, 'seed'),
    black: hex(obj, 'black', PUBLIC_KEY_BYTES, 'seed'),
  };
  if (seed.white === seed.black) throw new Error('chess seed players must be distinct');
  return seed;
}

export function encodeAction(action: ChessAction): Uint8Array {
  return str2bin(
    action.type === 'timeout' ? JSON.stringify({ type: 'timeout' }) : JSON.stringify({
      type: 'move',
      from: action.move.from,
      to: action.move.to,
      promotion: action.move.promotion,
    }),
  );
}

export function decodeAction(bytes: Uint8Array): ChessAction {
  const obj = parseObject(bytes, 'action');
  const type = obj.type;
  if (type === 'timeout') return { type };
  if (type !== 'move') {
    throw new Error(`chess action.type must be 'move' or 'timeout', got ${String(type)}`);
  }
  return {
    type,
    move: {
      from: integer(obj, 'from', 63, 'action'),
      to: integer(obj, 'to', 63, 'action'),
      promotion: integer(obj, 'promotion', 12, 'action'),
    },
  };
}

export function encodeState(state: ChessState): Uint8Array {
  if (state.game.board.length !== 64) {
    throw new Error(`chess board must be 64 squares, got ${state.game.board.length}`);
  }
  return str2bin(JSON.stringify({
    board: [...state.game.board],
    toMove: state.game.toMove,
    castling: state.game.castling,
    enPassant: state.game.enPassant,
    halfmoveClock: state.game.halfmoveClock,
    fullmove: state.game.fullmove,
    status: state.game.status,
    white: state.white,
    black: state.black,
  }));
}

export function decodeState(bytes: Uint8Array): ChessState {
  const obj = parseObject(bytes, 'state');

  const board = obj.board;
  if (!Array.isArray(board) || board.length !== 64) {
    throw new Error(`chess state.board must be 64 squares, got ${JSON.stringify(board)}`);
  }
  const squares = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    squares[i] = integer(board as unknown as Record<string, unknown>, String(i), 12, 'state.board');
  }

  const enPassant = integer(obj, 'enPassant', 0xff, 'state');
  if (enPassant > 63 && enPassant !== 0xff) {
    throw new Error(`chess state.enPassant must be a square or 255, got ${enPassant}`);
  }

  const game: GameState = {
    board: squares,
    toMove: integer(obj, 'toMove', 1, 'state') as Color,
    castling: integer(obj, 'castling', 0b1111, 'state'),
    enPassant,
    halfmoveClock: integer(obj, 'halfmoveClock', Number.MAX_SAFE_INTEGER, 'state'),
    fullmove: integer(obj, 'fullmove', Number.MAX_SAFE_INTEGER, 'state'),
    status: integer(obj, 'status', 3, 'state') as Status,
  };

  return {
    game,
    white: hex(obj, 'white', PUBLIC_KEY_BYTES, 'state'),
    black: hex(obj, 'black', PUBLIC_KEY_BYTES, 'state'),
  };
}
