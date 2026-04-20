#!/usr/bin/env -S deno run --allow-all
/**
 * Harness observer. Tails every `events/*.jsonl` file under a run
 * directory, parses JSON lines, and streams to postgres via PgIngester.
 *
 * Usage:
 *
 *   deno run --allow-all harness/observer.ts <runs-root> <run-id> [postgres-url]
 *
 * Resumes from per-session byte offsets stored in `ingest_offsets` so
 * restarts don't reprocess (or miss) events.
 */

import { type IngestedEvent, PgIngester } from './ingest.ts';

const POLL_MS = 100;

interface SessionTailState {
  sessionId: string;
  path: string;
  offset: number;
  fileHandle?: Deno.FsFile;
  residual: string;
}

async function main(): Promise<void> {
  const [runsRoot, runId, pgUrl] = Deno.args;
  if (!runsRoot || !runId) {
    console.error(
      'Usage: deno run --allow-all harness/observer.ts <runs-root> <run-id> [postgres-url]',
    );
    Deno.exit(1);
  }
  const pg = new PgIngester({
    postgresUrl: pgUrl ?? 'postgres://localhost/scaffold_harness',
    onError: (err) => {
      console.error('[observer] ingest error:', err.message);
    },
  });

  const runDir = `${runsRoot}/${runId}`;
  const eventsDir = `${runDir}/events`;
  const coordinatorLog = `${runDir}/coordinator.jsonl`;

  const offsets = await pg.getOffsets(runId);

  const states = new Map<string, SessionTailState>();

  const seedState = (file: string): void => {
    if (!file.endsWith('.jsonl')) return;
    const sessionId = file.slice(0, -'.jsonl'.length);
    if (states.has(sessionId)) return;
    states.set(sessionId, {
      sessionId,
      path: `${eventsDir}/${file}`,
      offset: offsets.get(sessionId) ?? 0,
      residual: '',
    });
  };

  try {
    for (const entry of Deno.readDirSync(eventsDir)) {
      seedState(entry.name);
    }
  } catch {
    console.error(`[observer] events dir not found: ${eventsDir}`);
    Deno.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await pg.flush().catch(() => {});
    await pg.close().catch(() => {});
    Deno.exit(0);
  };
  Deno.addSignalListener('SIGINT', () => void shutdown());
  Deno.addSignalListener('SIGTERM', () => void shutdown());

  console.error(`[observer] tailing ${eventsDir}`);

  // Poll loop: discover new files, tail each known file.
  while (!shuttingDown) {
    try {
      for (const entry of Deno.readDirSync(eventsDir)) seedState(entry.name);
    } catch { /* dir may have been removed mid-run */ }

    for (const state of states.values()) {
      await tailOne(state, pg, runId);
    }

    // Also tail the coordinator log for run-level signals.
    await tailCoordinator(coordinatorLog, pg, runId);

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function tailOne(
  state: SessionTailState,
  pg: PgIngester,
  runId: string,
): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(state.path);
  } catch {
    return;
  }
  if (stat.size <= state.offset) return;

  if (!state.fileHandle) {
    state.fileHandle = await Deno.open(state.path, { read: true });
  }
  await state.fileHandle.seek(state.offset, Deno.SeekMode.Start);

  const buf = new Uint8Array(stat.size - state.offset);
  let read = 0;
  while (read < buf.byteLength) {
    const n = await state.fileHandle.read(buf.subarray(read));
    if (n === null) break;
    read += n;
  }
  state.offset += read;
  const text = state.residual + new TextDecoder().decode(buf.subarray(0, read));
  const lines = text.split('\n');
  state.residual = lines.pop() ?? '';

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    const ev = toIngested(parsed, runId, state.sessionId);
    if (ev) pg.push(ev);
  }

  // Persist offset periodically (cheap; idempotent).
  pg.saveOffset(runId, state.sessionId, state.offset).catch(() => {});
}

let coordinatorOffset = 0;
let coordinatorResidual = '';
let coordinatorSeq = 0;
const stderrCounters = new Map<string, number>();

async function tailCoordinator(path: string, pg: PgIngester, runId: string): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch {
    return;
  }
  if (stat.size <= coordinatorOffset) return;

  const f = await Deno.open(path, { read: true });
  try {
    await f.seek(coordinatorOffset, Deno.SeekMode.Start);
    const buf = new Uint8Array(stat.size - coordinatorOffset);
    let read = 0;
    while (read < buf.byteLength) {
      const n = await f.read(buf.subarray(read));
      if (n === null) break;
      read += n;
    }
    coordinatorOffset += read;
    const text = coordinatorResidual + new TextDecoder().decode(buf.subarray(0, read));
    const lines = text.split('\n');
    coordinatorResidual = lines.pop() ?? '';

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(t);
      } catch {
        continue;
      }
      // Feed coordinator events as a special session id for the same run.
      const ev: IngestedEvent = {
        runId,
        sessionId: '__coordinator__',
        seq: coordinatorSeq++,
        wallTs: Number(parsed.wallTs ?? Date.now()),
        system: 'coordinator',
        event: String(parsed.event ?? 'unknown'),
        kind: 'event',
        data: (parsed.data as Record<string, unknown>) ?? {},
      };
      pg.push(ev);

      // Also react to specific coordinator events to populate app_sessions
      // and close out runs.
      if (parsed.event === 'session.spawned') {
        const d = parsed.data as Record<string, unknown>;
        pg.upsertSession({
          runId,
          sessionId: String(d.sessionId),
          application: String(d.application),
          userPubkey: d.pubkey as string,
          address: d.socketPath as string,
          lat: (d.coord as { lat?: number })?.lat,
          lon: (d.coord as { lon?: number })?.lon,
          isAnchor: Boolean(d.isAnchor),
          startedAt: new Date(Number(parsed.wallTs)),
        }).catch(() => {});
      } else if (parsed.event === 'session.exited') {
        const d = parsed.data as Record<string, unknown>;
        pg.markSessionEnded(
          runId,
          String(d.sessionId),
          (d.exitCode as number | null) ?? null,
          (d.exitSignal as string | null) ?? null,
        ).catch(() => {});
      } else if (parsed.event === 'run.ended') {
        pg.markRunEnded(runId).catch(() => {});
      } else if (parsed.event === 'run.started') {
        pg.upsertRun(runId, '', undefined).catch(() => {});
      }
    }
  } finally {
    f.close();
  }
}

function toIngested(
  line: Record<string, unknown>,
  runId: string,
  sessionId: string,
): IngestedEvent | null {
  const kind = (line.kind as string | undefined) ?? 'event';

  if (kind === 'event') {
    const seq = Number(line.seq ?? 0);
    return {
      runId,
      sessionId,
      seq,
      wallTs: Number(line.wallTs ?? Date.now()),
      ts: typeof line.ts === 'number' ? line.ts : undefined,
      system: String(line.system ?? 'unknown'),
      event: String(line.event ?? 'unknown'),
      level: (line.level as string | undefined) ?? 'info',
      kind,
      data: (line.data as Record<string, unknown>) ?? {},
    };
  }

  if (kind === 'app') {
    return {
      runId,
      sessionId,
      seq: Number(line.seq ?? 0),
      wallTs: Number(line.wallTs ?? Date.now()),
      system: 'app',
      event: String(line.event ?? 'unknown'),
      level: (line.level as string | undefined) ?? 'info',
      kind: 'app',
      data: (line.data as Record<string, unknown>) ?? {},
    };
  }

  if (kind === 'stderr') {
    // Stderr has no seq; use a wall-clock-derived rolling counter.
    const stderrSeq = (stderrCounters.get(sessionId) ?? 0) + 1;
    stderrCounters.set(sessionId, stderrSeq);
    return {
      runId,
      sessionId,
      seq: stderrSeq,
      wallTs: Number(line.wallTs ?? Date.now()),
      system: 'app',
      event: 'stderr',
      level: 'warn',
      kind: 'stderr',
      data: { text: line.text },
    };
  }

  return null;
}

if (import.meta.main) {
  await main();
}
