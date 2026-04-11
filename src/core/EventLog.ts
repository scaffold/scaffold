/**
 * Structured event log with ring buffer storage and query API.
 *
 * Every significant protocol event is recorded here with a monotonic
 * sequence number and high-resolution timestamp. The log is queryable
 * by system, event name, block hash, and sequence range.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Monotonic sequence number (global across all systems). */
  seq: number;
  /** High-resolution timestamp (performance.now or Date.now fallback). */
  ts: number;
  /** Subsystem that emitted this entry (e.g. 'coordinator', 'consensus'). */
  system: string;
  /** Event name (e.g. 'blockReceived', 'canonicalityChange'). */
  event: string;
  /** Structured event data. */
  data: Record<string, unknown>;
  /** Severity level. */
  level: LogLevel;
}

export interface LogQuery {
  /** Filter by subsystem name. */
  system?: string;
  /** Filter by event name (exact match). */
  event?: string;
  /** Only entries with seq >= since. */
  since?: number;
  /** Only entries with seq <= until. */
  until?: number;
  /** Filter entries whose data contains this block hash (prefix match). */
  block?: string;
  /** Maximum number of entries to return. */
  limit?: number;
  /** Filter by level (returns entries at this level or above). */
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const now = typeof performance !== 'undefined'
  ? () => performance.now()
  : () => Date.now();

export class EventLog {
  private buffer: LogEntry[] = [];
  private seq = 0;
  private readonly maxSize: number;
  private readonly consoleOutput: boolean;

  constructor(opts?: { maxSize?: number; console?: boolean }) {
    this.maxSize = opts?.maxSize ?? 10_000;
    this.consoleOutput = opts?.console ?? false;
  }

  /** Append a log entry. Returns the assigned sequence number. */
  append(
    system: string,
    event: string,
    data: Record<string, unknown>,
    level: LogLevel = 'info',
  ): number {
    const entry: LogEntry = {
      seq: this.seq++,
      ts: now(),
      system,
      event,
      data,
      level,
    };
    this.buffer.push(entry);

    // Trim when buffer exceeds max -- keep the recent half
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-Math.floor(this.maxSize * 0.75));
    }

    if (this.consoleOutput) {
      this._consoleEmit(entry);
    }

    return entry.seq;
  }

  /** Query entries matching the filter. */
  query(filter?: LogQuery): LogEntry[] {
    const minLevel = filter?.level ? LEVEL_ORDER[filter.level] : 0;
    const limit = filter?.limit ?? 500;
    const results: LogEntry[] = [];

    for (let i = this.buffer.length - 1; i >= 0 && results.length < limit; i--) {
      const e = this.buffer[i];
      if (filter?.since !== undefined && e.seq < filter.since) break; // buffer is ordered
      if (filter?.until !== undefined && e.seq > filter.until) continue;
      if (filter?.system && e.system !== filter.system) continue;
      if (filter?.event && e.event !== filter.event) continue;
      if (LEVEL_ORDER[e.level] < minLevel) continue;
      if (filter?.block && !this._matchesBlock(e, filter.block)) continue;
      results.push(e);
    }

    return results.reverse(); // Return in chronological order
  }

  /** Get the last N entries. */
  last(n = 20): LogEntry[] {
    return this.buffer.slice(-n);
  }

  /** Get all entries related to a specific block hash (prefix match). */
  forBlock(hashPrefix: string): LogEntry[] {
    return this.buffer.filter((e) => this._matchesBlock(e, hashPrefix));
  }

  /** Current sequence number (next entry will get this seq). */
  get nextSeq(): number {
    return this.seq;
  }

  /** Total entries currently in the buffer. */
  get size(): number {
    return this.buffer.length;
  }

  /** Clear all entries. */
  clear(): void {
    this.buffer.length = 0;
  }

  private _matchesBlock(entry: LogEntry, hashPrefix: string): boolean {
    const prefix = hashPrefix.toLowerCase();
    const d = entry.data;
    for (const key of Object.keys(d)) {
      const val = d[key];
      if (typeof val === 'string' && val.toLowerCase().startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  // deno-lint-ignore no-console
  private _consoleEmit(entry: LogEntry): void {
    const tag = `%c${entry.system}%c ${entry.event}`;
    const systemStyle = 'color: #888; font-weight: bold';
    const eventStyle = 'color: inherit; font-weight: normal';
    const fn = entry.level === 'error'
      ? console.error
      : entry.level === 'warn'
      ? console.warn
      : entry.level === 'debug'
      ? console.debug
      : console.info;
    // Shorten hashes in the data for readability
    const compact = shortenHashes(entry.data);
    fn(tag, systemStyle, eventStyle, compact);
  }
}

/**
 * Scoped logger bound to a specific subsystem.
 * Modules hold a reference to one of these and call its methods.
 */
export class ScopedLogger {
  constructor(
    private readonly log: EventLog,
    private readonly system: string,
  ) {}

  debug(event: string, data: Record<string, unknown> = {}): void {
    this.log.append(this.system, event, data, 'debug');
  }

  info(event: string, data: Record<string, unknown> = {}): void {
    this.log.append(this.system, event, data, 'info');
  }

  warn(event: string, data: Record<string, unknown> = {}): void {
    this.log.append(this.system, event, data, 'warn');
  }

  error(event: string, data: Record<string, unknown> = {}): void {
    this.log.append(this.system, event, data, 'error');
  }

  /** Create a child logger with a more specific system name. */
  child(subsystem: string): ScopedLogger {
    return new ScopedLogger(this.log, `${this.system}.${subsystem}`);
  }
}

const HEX_RE = /^[0-9a-f]{16,}$/i;

/** Shorten hex hashes in a data object for console readability. */
function shortenHashes(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    result[key] = shortenValue(data[key]);
  }
  return result;
}

function shortenValue(val: unknown): unknown {
  if (typeof val === 'string' && HEX_RE.test(val)) {
    return val.slice(0, 8) + '..';
  }
  if (Array.isArray(val)) {
    return val.map(shortenValue);
  }
  if (val && typeof val === 'object') {
    return shortenHashes(val as Record<string, unknown>);
  }
  return val;
}
