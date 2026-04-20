#!/usr/bin/env -S deno run --allow-all
/**
 * Harness coordinator. Entry point:
 *
 *   deno run --allow-all harness/coordinator.ts <config.yaml>
 *
 * Loads the YAML config, builds a keypool + harness genesis, spawns
 * anchor processes, then schedules app sessions via per-application
 * Poisson spawn rates for `run.duration_s`. On exit or SIGINT, cleans up
 * child processes + socket files and writes a terminal coordinator event.
 */

import { loadHarnessConfig } from './config.ts';
import type { ApplicationConfig, HarnessConfig } from './config.ts';
import { buildUserPool, KeyPool } from './keypool.ts';
import { buildHarnessGenesis } from './genesisBuilder.ts';
import { RandomUniformGeography } from './geography.ts';
import { writePeerManifest } from './peerManifest.ts';
import { exponential, gaussian, mulberry32, type Rng } from './rand.ts';
import type { PeerEntry, SessionId, UserKey } from './types.ts';
import { spawnApp, type SpawnHandle } from './spawner.ts';
import { Supervisor, sweepOrphanSockets } from './supervisor.ts';
import { bin2hex } from '../src/util/hex.ts';

interface CoordinatorState {
  config: HarnessConfig;
  runDir: string;
  eventsDir: string;
  stderrDir: string;
  peersPath: string;
  genesisPath: string;
  coordinatorLogPath: string;
  coordinatorLogFile: Deno.FsFile;
  keypool: KeyPool;
  geography: RandomUniformGeography;
  supervisor: Supervisor;
  peers: Map<SessionId, PeerEntry>;
  sessionToUser: Map<SessionId, UserKey>;
  sessionSeq: number;
  rand: Rng;
}

const encoder = new TextEncoder();

function emit(state: CoordinatorState, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    runId: state.config.run.id,
    wallTs: Date.now(),
    system: 'coordinator',
    event,
    data,
  }) + '\n';
  try {
    state.coordinatorLogFile.writeSync(encoder.encode(line));
  } catch { /* log file closed */ }
  // Also mirror to stdout so you can tail the coordinator in one window.
  try {
    Deno.stdout.writeSync(encoder.encode(line));
  } catch { /* ignore */ }
}

async function updatePeerManifest(state: CoordinatorState): Promise<void> {
  await writePeerManifest(state.peersPath, {
    runId: state.config.run.id,
    writtenAtMs: Date.now(),
    peers: [...state.peers.values()],
  });
}

function nextSessionId(state: CoordinatorState, application: string): SessionId {
  return `${application}-${state.sessionSeq++}`;
}

function pickBootstrap(state: CoordinatorState, selfAddr: string): string[] {
  const anchors: PeerEntry[] = [];
  const others: PeerEntry[] = [];
  for (const p of state.peers.values()) {
    if (p.address === selfAddr) continue;
    (p.isAnchor ? anchors : others).push(p);
  }
  const targetTotal = state.config.bootstrap.peers_per_new_app;
  // Prefer all anchors, then fill with random recent non-anchors.
  const chosen: PeerEntry[] = anchors.slice(0, targetTotal);
  // Fisher-Yates shuffle on `others` using the coordinator RNG.
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(state.rand() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  for (const o of others) {
    if (chosen.length >= targetTotal) break;
    chosen.push(o);
  }
  return chosen.map((p) => p.address);
}

async function spawnSession(
  state: CoordinatorState,
  app: ApplicationConfig,
): Promise<void> {
  const user = state.keypool.checkout(state.rand);
  if (!user) {
    emit(state, 'spawn.poolExhausted', { application: app.name });
    return;
  }

  const sessionId = nextSessionId(state, app.name);
  const coord = state.geography.sampleCoord(state.rand);
  const socketPath =
    `${state.config.paths.socket_root}/sh-${state.config.run.id}-${sessionId}.sock`;
  const bootstrap = pickBootstrap(state, socketPath);

  const sessionDurationMs = app.is_anchor || !app.session_duration_s ? '' : String(
    Math.max(
      1000,
      gaussian(state.rand, app.session_duration_s.mean, app.session_duration_s.stddev) * 1000,
    ),
  );

  const env: Record<string, string> = {
    RUN_ID: state.config.run.id,
    SESSION_ID: sessionId,
    APPLICATION: app.name,
    PRIVATE_KEY_HEX: bin2hex(user.privateKey),
    GENESIS_PATH: state.genesisPath,
    SOCKET_PATH: socketPath,
    SOCKET_ROOT: state.config.paths.socket_root,
    LAT: String(coord.lat),
    LON: String(coord.lon),
    PEERS_PATH: state.peersPath,
    BOOTSTRAP: bootstrap.join(','),
    SESSION_DURATION_MS: sessionDurationMs,
    PARAMS_JSON: JSON.stringify(app.params),
    RNG_SEED: `${state.config.run.base_seed}:${sessionId}`,
    SPEED_FACTOR: String(state.config.geography.latency.speed_factor),
    JITTER_MIN_MS: String(state.config.geography.latency.jitter_min_ms),
    JITTER_MAX_MS: String(state.config.geography.latency.jitter_max_ms),
    MIN_MS: String(state.config.geography.latency.min_ms),
    FLEET_FALLBACK_MS: String(state.config.geography.latency.fleet_fallback_ms),
    IS_ANCHOR: app.is_anchor ? '1' : '0',
  };

  const eventsPath = `${state.eventsDir}/${sessionId}.jsonl`;
  const stderrPath = `${state.stderrDir}/${sessionId}.log`;

  let handle: SpawnHandle;
  try {
    handle = spawnApp({
      sessionId,
      entrypoint: app.entrypoint,
      env,
      eventsPath,
      stderrPath,
      onEvent: (_e) => {
        // For v1 the coordinator only needs lifecycle signals, which it
        // derives from process exit. Future: consume peer_connected etc.
      },
    });
  } catch (err) {
    state.keypool.return(user);
    emit(state, 'spawn.failed', {
      application: app.name,
      sessionId,
      error: String(err),
    });
    return;
  }

  state.supervisor.track(handle, socketPath);
  state.sessionToUser.set(sessionId, user);

  const entry: PeerEntry = {
    sessionId,
    application: app.name,
    pubkeyHex: user.pubkeyHex,
    address: socketPath,
    coord,
    startedAtMs: Date.now(),
    isAnchor: app.is_anchor,
  };
  state.peers.set(sessionId, entry);
  await updatePeerManifest(state);

  emit(state, 'session.spawned', {
    sessionId,
    application: app.name,
    pubkey: user.pubkeyHex,
    coord,
    socketPath,
    bootstrap,
    isAnchor: app.is_anchor,
    pid: handle.pid,
  });

  // Background: when this session exits, return its keypair and update peers.
  handle.status.then(async (status) => {
    state.peers.delete(sessionId);
    state.sessionToUser.delete(sessionId);
    state.keypool.return(user);
    state.supervisor.untrack(sessionId, socketPath);
    await updatePeerManifest(state).catch(() => {});
    emit(state, 'session.exited', {
      sessionId,
      application: app.name,
      exitCode: status.code,
      exitSignal: status.signal ?? null,
    });
  }).catch(() => {
    // wait errors are fine; the session is dead
  });

  // Termination policy: for non-anchors, schedule the session's natural
  // end. A fraction of sessions are force-closed (SIGKILL) at the end.
  if (!app.is_anchor && sessionDurationMs) {
    const ms = Number(sessionDurationMs);
    setTimeout(() => {
      const force = state.rand() < state.config.run.force_close_rate;
      state.supervisor.terminate(
        sessionId,
        { kind: force ? 'sigkill' : 'sigterm' },
      );
      emit(state, 'session.terminationIssued', {
        sessionId,
        kind: force ? 'sigkill' : 'sigterm',
      });
    }, ms);
  }
}

async function runAnchors(state: CoordinatorState): Promise<void> {
  const anchorApps = state.config.applications.filter((a) => a.is_anchor);
  const desiredAnchors = state.config.bootstrap.anchor_count;
  if (anchorApps.length === 0 && desiredAnchors > 0) {
    emit(state, 'anchor.configMissing', {
      desiredAnchors,
      hint: 'No application has is_anchor: true. Add one or set anchor_count to 0.',
    });
    return;
  }
  for (let i = 0; i < desiredAnchors; i++) {
    const app = anchorApps[i % anchorApps.length];
    await spawnSession(state, app);
    // Stagger anchor spawns so listeners come up before newcomers dial.
    await delay(200);
  }
}

async function scheduleApplications(state: CoordinatorState): Promise<void> {
  const nonAnchors = state.config.applications.filter((a) => !a.is_anchor);
  const endWall = Date.now() + state.config.run.duration_s * 1000;

  // Each non-anchor app gets its own Poisson-ish schedule. We sample next
  // interarrival times independently per app type and race them.
  const nextAt = new Map<string, number>();
  const nowMs = Date.now();
  for (const app of nonAnchors) {
    const dt = exponential(state.rand, app.spawn_rate_per_s);
    nextAt.set(app.name, nowMs + dt * 1000);
  }

  while (Date.now() < endWall) {
    // Find the soonest-due app.
    let soonest: string | null = null;
    let soonestAt = Infinity;
    for (const [name, at] of nextAt) {
      if (at < soonestAt) {
        soonest = name;
        soonestAt = at;
      }
    }
    if (!soonest || soonestAt === Infinity) {
      await delay(Math.min(1000, endWall - Date.now()));
      continue;
    }
    const wait = Math.max(0, Math.min(endWall - Date.now(), soonestAt - Date.now()));
    if (wait > 0) await delay(wait);
    if (Date.now() >= endWall) break;

    const app = nonAnchors.find((a) => a.name === soonest)!;
    // Fire and forget; we don't await spawnSession so interarrival
    // scheduling stays on schedule.
    spawnSession(state, app).catch((err) => {
      emit(state, 'spawn.uncaughtError', { error: String(err) });
    });

    // Reschedule this app.
    const dt = exponential(state.rand, app.spawn_rate_per_s);
    nextAt.set(app.name, Date.now() + dt * 1000);
  }

  emit(state, 'schedule.ended', { durationS: state.config.run.duration_s });
}

async function main(): Promise<void> {
  const args = Deno.args;
  if (args.length < 1) {
    console.error('Usage: deno run --allow-all harness/coordinator.ts <config.yaml>');
    Deno.exit(1);
  }
  const config = await loadHarnessConfig(args[0]);
  if (config.run.id === 'auto') {
    (config.run as { id: string }).id = `r-${Date.now()}`;
  }

  const runDir = `${config.paths.runs_root}/${config.run.id}`;
  const eventsDir = `${runDir}/events`;
  const stderrDir = `${runDir}/stderr`;
  const peersPath = `${runDir}/peers.json`;
  const genesisPath = `${runDir}/genesis.hex`;
  const coordinatorLogPath = `${runDir}/coordinator.jsonl`;

  await Deno.mkdir(eventsDir, { recursive: true });
  await Deno.mkdir(stderrDir, { recursive: true });

  const coordinatorLogFile = Deno.openSync(coordinatorLogPath, {
    write: true,
    create: true,
    append: true,
  });

  const rand = mulberry32(config.run.base_seed);

  const swept = sweepOrphanSockets(
    config.paths.socket_root,
    `sh-${config.run.id}-`,
  );

  const users = buildUserPool({
    count: config.users.count,
    seedPrefix: config.users.seed_prefix,
    balance: {
      zeroFraction: config.users.balance_distribution.zero_fraction,
      powerLaw: config.users.balance_distribution.power_law,
    },
  }, rand);
  const { packetHex, block: genesis } = buildHarnessGenesis(users);
  await Deno.writeTextFile(genesisPath, packetHex);

  const keypool = new KeyPool(users);
  const geography = new RandomUniformGeography({
    speedFactor: config.geography.latency.speed_factor,
    jitterMinMs: config.geography.latency.jitter_min_ms,
    jitterMaxMs: config.geography.latency.jitter_max_ms,
    minMs: config.geography.latency.min_ms,
  });

  // Seed peers.json with an empty manifest so apps polling it from the
  // very first anchor can read something.
  await writePeerManifest(peersPath, {
    runId: config.run.id,
    writtenAtMs: Date.now(),
    peers: [],
  });

  const state: CoordinatorState = {
    config,
    runDir,
    eventsDir,
    stderrDir,
    peersPath,
    genesisPath,
    coordinatorLogPath,
    coordinatorLogFile,
    keypool,
    geography,
    supervisor: new Supervisor(),
    peers: new Map(),
    sessionToUser: new Map(),
    sessionSeq: 0,
    rand,
  };

  emit(state, 'run.started', {
    runId: config.run.id,
    userCount: users.length,
    genesisHash: genesis.hash.toHex(),
    orphanSocketsCleaned: swept,
    runDir,
  });

  // SIGINT: stop spawning, terminate fleet, flush.
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    emit(state, 'run.shuttingDown', { reason });
    await state.supervisor.shutdown();
    emit(state, 'run.ended', { reason });
    try {
      coordinatorLogFile.close();
    } catch { /* already closed */ }
    Deno.exit(0);
  };
  Deno.addSignalListener('SIGINT', () => void shutdown('SIGINT'));
  Deno.addSignalListener('SIGTERM', () => void shutdown('SIGTERM'));

  await runAnchors(state);
  await scheduleApplications(state);

  // Let outstanding sessions finish their scheduled durations (up to
  // a cap above the longest possible session).
  const graceEnd = Date.now() + 30_000;
  while (state.supervisor.size > 0 && Date.now() < graceEnd) {
    await delay(250);
  }

  await shutdown('duration_elapsed');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

if (import.meta.main) {
  await main();
}
