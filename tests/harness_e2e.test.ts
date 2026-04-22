/**
 * End-to-end smoke test for the harness App runtime: spawn three anchor
 * processes with a minimal peer manifest and verify they connect and
 * exchange peer_connected events on stdout JSONL.
 */

import { assert } from '@std/assert';
import { bin2hex } from '../src/util/hex.ts';
import { secp } from '../src/util/secp.ts';
import { Hash } from '../src/util/Hash.ts';
import { buildHarnessGenesis } from '../harness/genesisBuilder.ts';
import { writePeerManifest } from '../harness/peerManifest.ts';
import type { PeerEntry, UserKey } from '../harness/types.ts';
import { unixSocketsAvailable } from './helpers/unixSocketsAvailable.ts';

interface SpawnedAnchor {
  sessionId: string;
  pubkeyHex: string;
  socketPath: string;
  process: Deno.ChildProcess;
  events: Record<string, unknown>[];
  stdoutDone: Promise<void>;
}

function makeUser(seed: string): UserKey {
  const privateKey = Hash.digest(`scaffold:user:${seed}`).toBytes();
  const publicKey = secp.getPublicKey(privateKey, true);
  return {
    seed,
    privateKey,
    publicKey,
    pubkeyHex: bin2hex(publicKey),
    balance: 1_000_000,
  };
}

function startAnchor(args: {
  runId: string;
  sessionId: string;
  runDir: string;
  user: UserKey;
  genesisPath: string;
  peersPath: string;
  socketPath: string;
  bootstrap: string[];
  lat: number;
  lon: number;
}): SpawnedAnchor {
  const entrypoint = new URL(
    '../harness/applications/behaviors/anchor.ts',
    import.meta.url,
  ).pathname;

  const env: Record<string, string> = {
    RUN_ID: args.runId,
    SESSION_ID: args.sessionId,
    APPLICATION: 'anchor',
    PRIVATE_KEY_HEX: bin2hex(args.user.privateKey),
    GENESIS_PATH: args.genesisPath,
    SOCKET_PATH: args.socketPath,
    SOCKET_ROOT: args.runDir,
    LAT: String(args.lat),
    LON: String(args.lon),
    PEERS_PATH: args.peersPath,
    BOOTSTRAP: args.bootstrap.join(','),
    RNG_SEED: args.sessionId,
    SPEED_FACTOR: '0.5',
    JITTER_MIN_MS: '0',
    JITTER_MAX_MS: '2',
    MIN_MS: '1',
    FLEET_FALLBACK_MS: '10',
    IS_ANCHOR: '1',
    SESSION_DURATION_MS: '',
    PARAMS_JSON: '{}',
  };

  const cmd = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-all', entrypoint],
    env,
    stdout: 'piped',
    stderr: 'piped',
    clearEnv: true,
  });

  const process = cmd.spawn();
  const events: Record<string, unknown>[] = [];

  const stdoutDone = (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            events.push(JSON.parse(t));
          } catch {
            // skip garbled lines (shouldn't happen with writeSync)
          }
        }
      }
    } catch {
      // reader closed
    }
  })();

  // Consume stderr to prevent back-pressure; append to events for debugging.
  (async () => {
    const reader = process.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        // Attach stderr to events under a synthetic key for debugging.
        events.push({ kind: 'stderr', text });
      }
    } catch {
      // reader closed
    }
  })();

  return {
    sessionId: args.sessionId,
    pubkeyHex: args.user.pubkeyHex,
    socketPath: args.socketPath,
    process,
    events,
    stdoutDone,
  };
}

async function waitFor(
  fn: () => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

Deno.test({
  name: 'harness e2e: 3 anchors mesh-connect via UnixSocketTransport',
  // The harness App runtime is hardcoded to UnixSocketTransport, and this
  // test spawns real subprocesses. Sandboxed environments that deny
  // AF_UNIX bind() cannot run it; subprocesses lack shared memory for an
  // in-process transport, and TCP loopback is similarly blocked.
  ignore: !unixSocketsAvailable(),
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const runDir = await Deno.makeTempDir({ prefix: 'scaffold-harness-e2e-' });
    const runId = `r-${Date.now()}`;
    const peersPath = `${runDir}/peers.json`;

    const usersAll: UserKey[] = [
      makeUser('e2e-a'),
      makeUser('e2e-b'),
      makeUser('e2e-c'),
    ];
    const { packetHex } = buildHarnessGenesis(usersAll);
    const genesisPath = `${runDir}/genesis.hex`;
    await Deno.writeTextFile(genesisPath, packetHex);

    const sockets = [
      `${runDir}/a.sock`,
      `${runDir}/b.sock`,
      `${runDir}/c.sock`,
    ];

    const coords = [
      { lat: 37.7, lon: -122.4 },
      { lat: 40.7, lon: -74.0 },
      { lat: 51.5, lon: -0.1 },
    ];

    const peerEntries: PeerEntry[] = usersAll.map((u, i) => ({
      sessionId: `anchor-${i}`,
      application: 'anchor',
      pubkeyHex: u.pubkeyHex,
      address: sockets[i],
      coord: coords[i],
      startedAtMs: Date.now(),
      isAnchor: true,
    }));
    await writePeerManifest(peersPath, {
      runId,
      writtenAtMs: Date.now(),
      peers: peerEntries,
    });

    // Start anchor A first (no bootstrap). Then B bootstraps to A. Then
    // C bootstraps to A and B. This matches how the coordinator will
    // layer spawns.
    const anchors: SpawnedAnchor[] = [];
    try {
      anchors.push(startAnchor({
        runId,
        sessionId: 'anchor-0',
        runDir,
        user: usersAll[0],
        genesisPath,
        peersPath,
        socketPath: sockets[0],
        bootstrap: [],
        lat: coords[0].lat,
        lon: coords[0].lon,
      }));

      // Small delay so A's listener is up.
      await new Promise((r) => setTimeout(r, 300));

      anchors.push(startAnchor({
        runId,
        sessionId: 'anchor-1',
        runDir,
        user: usersAll[1],
        genesisPath,
        peersPath,
        socketPath: sockets[1],
        bootstrap: [sockets[0]],
        lat: coords[1].lat,
        lon: coords[1].lon,
      }));

      await new Promise((r) => setTimeout(r, 300));

      anchors.push(startAnchor({
        runId,
        sessionId: 'anchor-2',
        runDir,
        user: usersAll[2],
        genesisPath,
        peersPath,
        socketPath: sockets[2],
        bootstrap: [sockets[0], sockets[1]],
        lat: coords[2].lat,
        lon: coords[2].lon,
      }));

      // Wait for each anchor to report at least one peer_connected event.
      const hasPeerConnected = (a: SpawnedAnchor) =>
        a.events.some((e) => e.kind === 'app' && e.event === 'peer_connected');

      await waitFor(
        () => anchors.every(hasPeerConnected),
        10_000,
      );

      for (const a of anchors) {
        const startedCount = a.events.filter((e) =>
          e.kind === 'app' && e.event === 'started'
        ).length;
        assert(startedCount >= 1, `${a.sessionId} did not emit 'started'`);
      }
    } finally {
      for (const a of anchors) {
        try {
          a.process.kill('SIGTERM');
        } catch { /* already dead */ }
      }
      // Give each process up to 2s to exit cleanly.
      await Promise.race([
        Promise.all(anchors.map((a) => a.process.status)),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      for (const a of anchors) {
        try {
          a.process.kill('SIGKILL');
        } catch { /* already dead */ }
      }
      await Promise.all(anchors.map((a) => a.process.status));
      await Promise.all(anchors.map((a) => a.stdoutDone));
      await Deno.remove(runDir, { recursive: true }).catch(() => {});
    }
  },
});
