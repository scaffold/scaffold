/**
 * Shared types for the Scaffold harness.
 */

export type RunId = string;
export type SessionId = string;

export interface Coord {
  /** Latitude in degrees, [-90, 90]. */
  lat: number;
  /** Longitude in degrees, [-180, 180]. */
  lon: number;
}

/** Per-peer entry in the coordinator's directory (written to peers.json). */
export interface PeerEntry {
  sessionId: SessionId;
  application: string;
  pubkeyHex: string;
  address: string;
  coord: Coord;
  startedAtMs: number;
  isAnchor: boolean;
}

export interface UserKey {
  /** Deterministic seed string this user was derived from. */
  seed: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  pubkeyHex: string;
  balance: number;
}

/** Contract between the coordinator and an application process. */
export interface AppEnv {
  RUN_ID: string;
  SESSION_ID: string;
  APPLICATION: string;
  PRIVATE_KEY_HEX: string;
  GENESIS_PATH: string;
  SOCKET_PATH: string;
  LAT: string;
  LON: string;
  PEERS_PATH: string;
  BOOTSTRAP: string; // comma-separated list of socket paths
  SESSION_DURATION_MS: string; // "" for anchors
  PARAMS_JSON: string;
  RNG_SEED: string;
}
