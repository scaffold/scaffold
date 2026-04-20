/**
 * Spawn a harness application process. Redirects stdout to a per-session
 * JSONL file AND forwards parsed events to an in-process callback so the
 * coordinator can react to lifecycle events (started, peer_connected).
 * stderr is redirected to a per-session log file for crash analysis.
 */

import type { SessionId } from './types.ts';

export interface SpawnRequest {
  sessionId: SessionId;
  entrypoint: string;
  env: Record<string, string>;
  /** Absolute path to the events JSONL file for this session. */
  eventsPath: string;
  /** Absolute path to the stderr log file. */
  stderrPath: string;
  /** Fires for every parsed stdout JSON line. Must not throw. */
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface SpawnHandle {
  sessionId: SessionId;
  pid: number;
  process: Deno.ChildProcess;
  /** Resolves when the process exits. */
  status: Promise<Deno.CommandStatus>;
  /** Resolves when stdout draining is complete (used in teardown). */
  stdoutDone: Promise<void>;
  stderrDone: Promise<void>;
}

export function spawnApp(req: SpawnRequest): SpawnHandle {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ['run', '--allow-all', req.entrypoint],
    env: req.env,
    stdout: 'piped',
    stderr: 'piped',
    clearEnv: true,
  });
  const process = cmd.spawn();

  const eventsFile = Deno.openSync(req.eventsPath, {
    write: true,
    create: true,
    truncate: true,
  });
  const stderrFile = Deno.openSync(req.stderrPath, {
    write: true,
    create: true,
    truncate: true,
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stdoutDone = (async () => {
    const reader = process.stdout.getReader();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // Write raw bytes to disk (preserves exact line content).
        eventsFile.writeSync(value);
        // Parse lines for in-process event dispatch.
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        if (req.onEvent) {
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            try {
              req.onEvent(JSON.parse(t));
            } catch {
              // malformed line -- skip
            }
          }
        }
      }
    } catch {
      // stdout closed
    }
    try {
      eventsFile.close();
    } catch { /* already closed */ }
  })();

  const stderrDone = (async () => {
    const reader = process.stderr.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stderrFile.writeSync(value);
        // Mirror brief stderr into the events file too so observers see it.
        try {
          eventsFile.writeSync(
            encoder.encode(
              JSON.stringify({
                sessionId: req.sessionId,
                kind: 'stderr',
                wallTs: Date.now(),
                text: decoder.decode(value),
              }) + '\n',
            ),
          );
        } catch { /* events file may be closed */ }
      }
    } catch {
      // stderr closed
    }
    try {
      stderrFile.close();
    } catch { /* already closed */ }
  })();

  return {
    sessionId: req.sessionId,
    pid: process.pid,
    process,
    status: process.status,
    stdoutDone,
    stderrDone,
  };
}
