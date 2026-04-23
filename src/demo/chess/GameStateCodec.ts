// Fixed-width binary codec for chess GameState and Move. Used for:
//  - GAME_STATE output `data` (the full state)
//  - GAME_STATE verifier `params` (gameId + turnId)
//  - RECORD "move" output `data` (the move played by the current player)
//
// The encoding is deliberately fixed-width so verification cost is O(1) and
// the contract does not need to handle length prefixes or malformed inputs
// differently at each site.

import { type GameState, type Move } from './ChessRules.ts';

// -- Move codec ------------------------------------------------------
// 3 bytes: [from] [to] [promotion]

export const MOVE_BYTES = 3;

export function encodeMove(m: Move): Uint8Array {
  const out = new Uint8Array(MOVE_BYTES);
  out[0] = m.from & 0xff;
  out[1] = m.to & 0xff;
  out[2] = m.promotion & 0xff;
  return out;
}

export function decodeMove(bytes: Uint8Array): Move {
  if (bytes.length !== MOVE_BYTES) {
    throw new Error(`move must be ${MOVE_BYTES} bytes, got ${bytes.length}`);
  }
  return { from: bytes[0], to: bytes[1], promotion: bytes[2] };
}

// -- GameState codec -------------------------------------------------
// Layout (fixed width):
//   [0..64)   board (64 bytes)
//   [64]      toMove (1)
//   [65]      castling (1)
//   [66]      enPassant (1)
//   [67]      status (1)
//   [68..72)  halfmoveClock (u32 LE)
//   [72..76)  fullmove (u32 LE)
//   [76..80)  whiteClockMs (u32 LE)
//   [80..84)  blackClockMs (u32 LE)
//   [84..92)  lastMoveAt (u64 LE)
//   [92..125) white pubkey (33 bytes, compressed secp256k1)
//   [125..158) black pubkey (33 bytes, zeroed if awaiting_join)
//
// Total: 158 bytes.
export const GAME_STATE_BYTES = 158;
const PUBKEY_BYTES = 33;
const WHITE_PUBKEY_OFFSET = 92;
const BLACK_PUBKEY_OFFSET = 125;

/**
 * Full game-state payload includes the two player pubkeys. The pure rules
 * module doesn't need the pubkeys, so they live on this envelope type.
 */
export interface GameStateEnvelope {
  state: GameState;
  white: Uint8Array; // 33 bytes
  black: Uint8Array; // 33 bytes, all-zero if awaiting_join
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)
  ) >>> 0;
}

function writeU64LE(buf: Uint8Array, offset: number, value: number): void {
  // Encode as bigint to avoid precision loss at the 2^32 boundary.
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function readU64LE(buf: Uint8Array, offset: number): number {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(buf[offset + i]);
  }
  return Number(v);
}

export function encodeGameState(env: GameStateEnvelope): Uint8Array {
  if (env.state.board.length !== 64) throw new Error('board must be 64 bytes');
  if (env.white.length !== PUBKEY_BYTES) throw new Error('white pubkey must be 33 bytes');
  if (env.black.length !== PUBKEY_BYTES) throw new Error('black pubkey must be 33 bytes');

  const out = new Uint8Array(GAME_STATE_BYTES);
  out.set(env.state.board, 0);
  out[64] = env.state.toMove & 0xff;
  out[65] = env.state.castling & 0xff;
  out[66] = env.state.enPassant & 0xff;
  out[67] = env.state.status & 0xff;
  writeU32LE(out, 68, env.state.halfmoveClock);
  writeU32LE(out, 72, env.state.fullmove);
  writeU32LE(out, 76, env.state.whiteClockMs);
  writeU32LE(out, 80, env.state.blackClockMs);
  writeU64LE(out, 84, env.state.lastMoveAt);
  out.set(env.white, WHITE_PUBKEY_OFFSET);
  out.set(env.black, BLACK_PUBKEY_OFFSET);
  return out;
}

export function decodeGameState(bytes: Uint8Array): GameStateEnvelope {
  if (bytes.length !== GAME_STATE_BYTES) {
    throw new Error(`game state must be ${GAME_STATE_BYTES} bytes, got ${bytes.length}`);
  }
  const state: GameState = {
    board: bytes.slice(0, 64),
    toMove: (bytes[64] & 1) as 0 | 1,
    castling: bytes[65],
    enPassant: bytes[66],
    status: bytes[67] as GameState['status'],
    halfmoveClock: readU32LE(bytes, 68),
    fullmove: readU32LE(bytes, 72),
    whiteClockMs: readU32LE(bytes, 76),
    blackClockMs: readU32LE(bytes, 80),
    lastMoveAt: readU64LE(bytes, 84),
  };
  const white = bytes.slice(WHITE_PUBKEY_OFFSET, WHITE_PUBKEY_OFFSET + PUBKEY_BYTES);
  const black = bytes.slice(BLACK_PUBKEY_OFFSET, BLACK_PUBKEY_OFFSET + PUBKEY_BYTES);
  return { state, white, black };
}

/** True if the envelope's black pubkey is all zero (awaiting-join sentinel). */
export function isAwaitingJoin(env: GameStateEnvelope): boolean {
  return env.black.every((b) => b === 0);
}

export const ZERO_PUBKEY: Uint8Array = new Uint8Array(PUBKEY_BYTES);

// -- Verifier params codec (gameId + turnId) -------------------------
// 36 bytes: [gameId 32] [turnId u32 LE]

export const GAME_ID_BYTES = 32;
export const GAME_PARAMS_BYTES = GAME_ID_BYTES + 4;

export function encodeGameParams(gameId: Uint8Array, turnId: number): Uint8Array {
  if (gameId.length !== GAME_ID_BYTES) {
    throw new Error(`gameId must be ${GAME_ID_BYTES} bytes, got ${gameId.length}`);
  }
  const out = new Uint8Array(GAME_PARAMS_BYTES);
  out.set(gameId, 0);
  writeU32LE(out, GAME_ID_BYTES, turnId);
  return out;
}

export interface GameParams {
  gameId: Uint8Array; // 32 bytes
  turnId: number;
}

export function decodeGameParams(bytes: Uint8Array): GameParams {
  if (bytes.length !== GAME_PARAMS_BYTES) {
    throw new Error(`game params must be ${GAME_PARAMS_BYTES} bytes, got ${bytes.length}`);
  }
  return {
    gameId: bytes.slice(0, GAME_ID_BYTES),
    turnId: readU32LE(bytes, GAME_ID_BYTES),
  };
}

/**
 * Generate a 32-byte gameId by XOR-ing the creator's pubkey (truncated/padded
 * to 32 bytes) with a random nonce. Callers that want deterministic gameIds
 * (tests) should supply the nonce explicitly.
 */
export function makeGameId(creatorPubkey: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (nonce.length !== GAME_ID_BYTES) {
    throw new Error(`nonce must be ${GAME_ID_BYTES} bytes`);
  }
  const out = new Uint8Array(GAME_ID_BYTES);
  for (let i = 0; i < GAME_ID_BYTES; i++) {
    out[i] = nonce[i] ^ (creatorPubkey[i % creatorPubkey.length] ?? 0);
  }
  return out;
}
