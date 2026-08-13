import {
  LOG_ORDER,
  LogEvent,
  LoggingProvider,
  LogLevel,
} from '../src/interfaces/LoggingProvider.ts';
import { arrCall } from '../src/util/array.ts';
import { LevelFn, toLevelFn } from './logSpec.ts';

export interface LogEntry extends LogEvent {
  /** Monotonic sequence number, global across subsystems. */
  seq: number;
}

export interface LogQuery {
  system?: string;
  event?: string;
  /** Only entries with seq >= since. */
  since?: number;
  /** Only entries with seq <= until. */
  until?: number;
  /** Entries whose data holds a string starting with this (hash) prefix. */
  block?: string;
  limit?: number;
  /** Entries at this level or above. */
  level?: LogLevel;
}

/**
 * Queryable in-memory sink. Hosts hold the instance directly -- scaffold only
 * ever sees it as a `LoggingProvider` -- and subscribe or query it at will.
 */
export class EventLogProvider implements LoggingProvider {
  private buffer: LogEntry[] = [];
  private seq = 0;
  private maxSize: number;
  private levelFn: LevelFn;
  private subscribers = new Set<(entry: LogEntry) => void>();

  constructor(opts?: { level?: string | LevelFn; maxSize?: number }) {
    this.maxSize = opts?.maxSize ?? 10_000;
    this.levelFn = toLevelFn(opts?.level ?? 'debug');
  }

  level(system: string): LogLevel | undefined {
    return this.levelFn(system);
  }

  handle(event: LogEvent): void {
    const entry: LogEntry = { ...event, seq: this.seq++ };
    this.buffer.push(entry);

    // Trim in bulk rather than per-append -- keep the recent 75%
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-Math.floor(this.maxSize * 0.75));
    }

    // No logger here: a sink cannot log its own subscriber's failure
    arrCall(this.subscribers, [entry]);
  }

  /** Fires synchronously after the entry lands, so subscribers see buffer order. */
  onAppend(cb: (entry: LogEntry) => void, signal: AbortSignal): void {
    this.subscribers.add(cb);
    signal.addEventListener('abort', () => {
      this.subscribers.delete(cb);
    });
  }

  query(filter?: LogQuery): LogEntry[] {
    const minLevel = filter?.level ? LOG_ORDER[filter.level] : 0;
    const limit = filter?.limit ?? 500;
    const results: LogEntry[] = [];

    for (let i = this.buffer.length - 1; i >= 0 && results.length < limit; i--) {
      const e = this.buffer[i];
      if (filter?.since !== undefined && e.seq < filter.since) break; // buffer is ordered
      if (filter?.until !== undefined && e.seq > filter.until) continue;
      if (filter?.system !== undefined && e.system !== filter.system) continue;
      if (filter?.event !== undefined && e.event !== filter.event) continue;
      if (LOG_ORDER[e.level] < minLevel) continue;
      if (filter?.block !== undefined && !matchesBlock(e, filter.block)) continue;
      results.push(e);
    }

    return results.reverse();
  }

  last(n = 20): LogEntry[] {
    return this.buffer.slice(-n);
  }

  forBlock(hashPrefix: string): LogEntry[] {
    return this.buffer.filter((e) => matchesBlock(e, hashPrefix));
  }

  getNextSeq(): number {
    return this.seq;
  }

  getSize(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

function matchesBlock(entry: LogEntry, hashPrefix: string): boolean {
  const prefix = hashPrefix.toLowerCase();
  for (const key of Object.keys(entry.data)) {
    const val = entry.data[key];
    if (typeof val === 'string' && val.toLowerCase().startsWith(prefix)) return true;
  }
  return false;
}
