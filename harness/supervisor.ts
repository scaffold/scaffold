/**
 * Lifecycle management for spawned app processes. Tracks live sessions,
 * coordinates graceful shutdown, sweeps orphaned socket files.
 *
 * Termination policy:
 *   - forceCloseRate fraction of sessions get SIGKILL (silent leave; simulates
 *     abrupt browser tab close). In-flight latency-queued packets are
 *     abandoned, producing "send without matching recv" postgres evidence.
 *   - Remaining sessions get SIGTERM and a 2s grace period for scaffold.close().
 *   - Coordinator SIGINT: SIGTERM all, 2s grace, SIGKILL survivors.
 */

import type { SpawnHandle } from './spawner.ts';
import type { SessionId } from './types.ts';

export interface TerminationDecision {
  kind: 'sigterm' | 'sigkill';
}

export class Supervisor {
  private readonly sessions = new Map<SessionId, SpawnHandle>();
  private readonly socketPaths = new Set<string>();
  private shuttingDown = false;

  track(handle: SpawnHandle, socketPath: string): void {
    this.sessions.set(handle.sessionId, handle);
    this.socketPaths.add(socketPath);
  }

  untrack(sessionId: SessionId, socketPath: string): void {
    this.sessions.delete(sessionId);
    // Socket path is removed best-effort; fine to leave in the set if the
    // app already unlinked it.
    try {
      Deno.removeSync(socketPath);
    } catch { /* already gone */ }
    this.socketPaths.delete(socketPath);
  }

  /** Terminate one session. Does not wait for exit. */
  terminate(sessionId: SessionId, decision: TerminationDecision): boolean {
    const handle = this.sessions.get(sessionId);
    if (!handle) return false;
    try {
      handle.process.kill(decision.kind === 'sigkill' ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // already exited
    }
    return true;
  }

  /** Best-effort graceful shutdown of the entire fleet. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const handles = [...this.sessions.values()];
    for (const h of handles) {
      try {
        h.process.kill('SIGTERM');
      } catch { /* already dead */ }
    }

    await Promise.race([
      Promise.allSettled(handles.map((h) => h.status)),
      delay(2000),
    ]);

    for (const h of handles) {
      try {
        h.process.kill('SIGKILL');
      } catch { /* already dead */ }
    }
    await Promise.allSettled(handles.map((h) => h.status));
    await Promise.allSettled(handles.flatMap((h) => [h.stdoutDone, h.stderrDone]));

    // Sweep any remaining socket files.
    for (const p of this.socketPaths) {
      try {
        Deno.removeSync(p);
      } catch { /* already gone */ }
    }
    this.socketPaths.clear();
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sweep orphaned `scaffold-*` sockets left in a directory from a crashed run. */
export function sweepOrphanSockets(dir: string, prefix = 'scaffold-'): number {
  let count = 0;
  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.sock')) continue;
      try {
        Deno.removeSync(`${dir}/${entry.name}`);
        count++;
      } catch { /* ignore */ }
    }
  } catch { /* dir missing */ }
  return count;
}
