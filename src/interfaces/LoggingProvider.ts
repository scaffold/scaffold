// The whole logging surface scaffold exposes. A host supplies one
// `LoggingProvider` via `config.loggingProvider`; everything inside scaffold
// talks to a `Logger` handed out by `ctx.logger(system)`.
//
// `level()` is the gate, not just a filter: a system it returns undefined for
// yields no `Logger` at all, so `logger?.info(...)` short-circuits before its
// arguments are evaluated and disabled logging costs one undefined check. A
// provider that fans out to several sinks must therefore report the loosest
// level any sink wants -- events it gates out here never reach `handle`.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Ascending severity; compare with `LOG_ORDER[a] >= LOG_ORDER[b]`. */
export const LOG_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEvent {
  /** Dotted subsystem path, e.g. 'transport' or 'transport.joiner'. */
  system: string;
  /** Stable event name, not prose -- values belong in `data`. */
  event: string;
  level: LogLevel;
  /** From `config.timeProvider.nowMs()`, so seeded time stays deterministic. */
  timestamp: number;
  data: Record<string, unknown>;
}

/** A log sink plus the level policy that gates it. */
export interface LoggingProvider {
  /** Minimum level for a subsystem, or undefined to disable it entirely. */
  level(system: string): LogLevel | undefined;
  /** Never awaited; a slow sink must buffer internally. */
  handle(event: LogEvent): void;
}

export interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;

  /** Narrows to `system.name`, merging `data` into every event it emits. */
  child(name: string, data?: Record<string, unknown>): Logger | undefined;
}
