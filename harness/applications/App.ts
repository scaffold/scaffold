/**
 * Shared runtime for harness applications. An application file imports
 * runApplication(), passes a behavior function, and the runtime:
 *
 *  1. Reads env vars produced by the coordinator (see types.ts AppEnv).
 *  2. Builds Scaffold wrapped with LatencyTransport over UnixSocketTransport.
 *  3. Streams EventLog entries (and app-behavior events) as JSONL on stdout.
 *  4. Bootstraps to provided peer addresses.
 *  5. Runs the behavior with an AppContext; exits when it returns or a
 *     SIGTERM arrives (graceful scaffold.close()), or on SIGKILL (abrupt).
 */

import { Scaffold } from '../../src/Scaffold.ts';
import { UnixSocketTransport } from '../../src/node/UnixSocketTransport.ts';
import { hex2bin } from '../../src/util/hex.ts';
import { loadGenesisFromHex } from '../genesisBuilder.ts';
import { RandomUniformGeography } from '../geography.ts';
import { LatencyTransport } from '../transports/LatencyTransport.ts';
import { PeerDirectory } from '../transports/PeerDirectory.ts';
import { mulberry32, type Rng, seedFromString } from '../rand.ts';
import type { Coord, PeerEntry } from '../types.ts';

export interface AppContext {
  scaffold: Scaffold;
  runId: string;
  sessionId: string;
  application: string;
  coord: Coord;
  params: Record<string, unknown>;
  directory: PeerDirectory;
  random: Rng;
  /** Emit an app-behavior event. Goes to stdout as JSONL. */
  log(event: string, data?: Record<string, unknown>): void;
  /** Sleep until either ms elapses or shouldStop becomes true. */
  sleep(ms: number): Promise<void>;
  /** True once the coordinator has asked us to stop (SIGTERM). */
  shouldStop(): boolean;
}

export type Behavior = (ctx: AppContext) => Promise<void>;

export async function runApplication(behavior: Behavior): Promise<void> {
  const env = readEnv();

  const rand = mulberry32(seedFromString(env.RNG_SEED));

  const coord: Coord = { lat: parseFloat(env.LAT), lon: parseFloat(env.LON) };

  // Genesis is passed as a hex file path to keep the env var short and to
  // decouple coordinator write from app startup timing.
  const genesisHex = await Deno.readTextFile(env.GENESIS_PATH);
  const genesis = loadGenesisFromHex(genesisHex.trim());

  const privateKey = hex2bin(env.PRIVATE_KEY_HEX);

  // Geography + latency config come from env to avoid re-parsing YAML.
  const geography = new RandomUniformGeography({
    speedFactor: parseFloat(env.SPEED_FACTOR),
    jitterMinMs: parseFloat(env.JITTER_MIN_MS),
    jitterMaxMs: parseFloat(env.JITTER_MAX_MS),
    minMs: parseFloat(env.MIN_MS),
  });

  // Peer directory polls peers.json. Must be started before we build the
  // LatencyTransport so dialAddress lookups can succeed on our first
  // bootstrap connect.
  const directory = new PeerDirectory({
    path: env.PEERS_PATH,
    pollIntervalMs: 500,
  });
  await directory.start();

  const inner = new UnixSocketTransport({
    socketPath: env.SOCKET_PATH,
    authPathDir: env.SOCKET_ROOT,
  });
  const transport = new LatencyTransport({
    inner,
    localCoord: coord,
    directory,
    geography,
    rand,
    fleetFallbackMs: parseFloat(env.FLEET_FALLBACK_MS),
  });

  // enableLogging: false means EventLog still records entries but doesn't
  // mirror them to console.info/debug, which would corrupt our JSONL
  // stdout stream. We consume entries via onAppend instead.
  const scaffold = new Scaffold({
    privateKey,
    genesis,
    plugins: [transport],
    enableLogging: false,
  });

  // Stream EventLog -> stdout. Use writeSync on Deno.stdout so lines don't
  // get buffered and lost when SIGKILL arrives.
  const encoder = new TextEncoder();
  const emitLine = (line: Record<string, unknown>) => {
    const body = JSON.stringify({
      runId: env.RUN_ID,
      sessionId: env.SESSION_ID,
      wallTs: Date.now(),
      ...line,
    }) + '\n';
    try {
      Deno.stdout.writeSync(encoder.encode(body));
    } catch {
      // stdout closed; we're exiting
    }
  };

  scaffold.eventLog.onAppend((entry) => {
    emitLine({
      kind: 'event',
      seq: entry.seq,
      ts: entry.ts,
      system: entry.system,
      event: entry.event,
      level: entry.level,
      data: entry.data,
    });
  });

  emitLine({
    kind: 'app',
    event: 'started',
    data: {
      application: env.APPLICATION,
      pubkey: scaffold.publicKeyHex,
      coord,
      socketPath: env.SOCKET_PATH,
      isAnchor: env.IS_ANCHOR === '1',
    },
  });

  scaffold.start();

  // Bootstrap anonymously to each peer the coordinator told us about.
  const bootstrapAddrs = env.BOOTSTRAP.split(',').filter((s) => s.length > 0);
  for (const addr of bootstrapAddrs) {
    try {
      scaffold.bootstrapConnection('unix', addr);
      emitLine({ kind: 'app', event: 'bootstrap_dialed', data: { address: addr } });
    } catch (err) {
      emitLine({
        kind: 'app',
        event: 'bootstrap_failed',
        data: { address: addr, error: String(err) },
      });
    }
  }

  scaffold.onPeerConnected((peerId) => {
    emitLine({ kind: 'app', event: 'peer_connected', data: { peerId } });
  });
  scaffold.onPeerDisconnected((peerId) => {
    emitLine({ kind: 'app', event: 'peer_disconnected', data: { peerId } });
  });

  // SIGTERM handler: graceful stop path. Coordinator sends SIGTERM; we
  // set the flag and let the behavior unwind. SIGKILL is not interceptable
  // and is handled by the coordinator's observability queries (missing
  // recv events).
  let stopRequested = false;
  Deno.addSignalListener('SIGTERM', () => {
    stopRequested = true;
    emitLine({ kind: 'app', event: 'sigterm_received' });
  });

  // Session timer for graceful exits. Anchors pass "" as duration and
  // therefore never self-exit.
  const sessionDurationMs = env.SESSION_DURATION_MS
    ? parseFloat(env.SESSION_DURATION_MS)
    : Infinity;
  if (isFinite(sessionDurationMs)) {
    setTimeout(() => {
      stopRequested = true;
      emitLine({ kind: 'app', event: 'session_timer_elapsed' });
    }, sessionDurationMs);
  }

  const params: Record<string, unknown> = env.PARAMS_JSON ? JSON.parse(env.PARAMS_JSON) : {};

  const ctx: AppContext = {
    scaffold,
    runId: env.RUN_ID,
    sessionId: env.SESSION_ID,
    application: env.APPLICATION,
    coord,
    params,
    directory,
    random: rand,
    log: (event, data) => emitLine({ kind: 'app', event, data: data ?? {} }),
    sleep: async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !stopRequested) {
        const slice = Math.min(50, deadline - Date.now());
        await new Promise((r) => setTimeout(r, slice));
      }
    },
    shouldStop: () => stopRequested,
  };

  try {
    await behavior(ctx);
  } catch (err) {
    emitLine({
      kind: 'app',
      event: 'behavior_error',
      level: 'error',
      data: { error: String(err), stack: (err as Error).stack },
    });
  }

  emitLine({ kind: 'app', event: 'closing' });
  try {
    await scaffold.close();
  } catch (err) {
    emitLine({
      kind: 'app',
      event: 'close_error',
      level: 'error',
      data: { error: String(err) },
    });
  }
  directory.stop();
  emitLine({ kind: 'app', event: 'exited' });
  Deno.exit(0);
}

// -- Env parsing --------------------------------------------------------

interface ResolvedEnv {
  RUN_ID: string;
  SESSION_ID: string;
  APPLICATION: string;
  PRIVATE_KEY_HEX: string;
  GENESIS_PATH: string;
  SOCKET_PATH: string;
  SOCKET_ROOT: string;
  LAT: string;
  LON: string;
  PEERS_PATH: string;
  BOOTSTRAP: string;
  SESSION_DURATION_MS: string;
  PARAMS_JSON: string;
  RNG_SEED: string;
  SPEED_FACTOR: string;
  JITTER_MIN_MS: string;
  JITTER_MAX_MS: string;
  MIN_MS: string;
  FLEET_FALLBACK_MS: string;
  IS_ANCHOR: string;
}

function readEnv(): ResolvedEnv {
  const required = [
    'RUN_ID',
    'SESSION_ID',
    'APPLICATION',
    'PRIVATE_KEY_HEX',
    'GENESIS_PATH',
    'SOCKET_PATH',
    'LAT',
    'LON',
    'PEERS_PATH',
    'RNG_SEED',
    'SPEED_FACTOR',
    'JITTER_MIN_MS',
    'JITTER_MAX_MS',
    'MIN_MS',
    'FLEET_FALLBACK_MS',
  ];
  const out: Record<string, string> = {};
  for (const k of required) {
    const v = Deno.env.get(k);
    if (v === undefined || v === '') {
      throw new Error(`missing required env var: ${k}`);
    }
    out[k] = v;
  }
  out.SOCKET_ROOT = Deno.env.get('SOCKET_ROOT') ?? '/tmp';
  out.BOOTSTRAP = Deno.env.get('BOOTSTRAP') ?? '';
  out.SESSION_DURATION_MS = Deno.env.get('SESSION_DURATION_MS') ?? '';
  out.PARAMS_JSON = Deno.env.get('PARAMS_JSON') ?? '{}';
  out.IS_ANCHOR = Deno.env.get('IS_ANCHOR') ?? '0';
  return out as unknown as ResolvedEnv;
}

/** Helper for behaviors that want to browse recent peers for migration. */
export function recentPeers(ctx: AppContext, exclude: Set<string> = new Set()): PeerEntry[] {
  const me = ctx.scaffold.publicKeyHex;
  return ctx.directory.snapshot().filter((p) => p.pubkeyHex !== me && !exclude.has(p.pubkeyHex));
}
