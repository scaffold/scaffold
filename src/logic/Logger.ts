import {
  LOG_ORDER,
  LogEvent,
  Logger,
  LoggingProvider,
  LogLevel,
} from '../interfaces/LoggingProvider.ts';

// `nowMs` is a closure rather than the TimeProvider itself so this module does
// not have to import Config, which would close a cycle back through Context.
export class ScopedLogger implements Logger {
  private constructor(
    private provider: LoggingProvider,
    private nowMs: () => number,
    private system: string,
    private minLevel: LogLevel,
    private bound: Record<string, unknown> | undefined,
  ) {}

  // The only construction path: undefined here is what makes `logger?.info(...)`
  // free for a disabled subsystem.
  static create(
    provider: LoggingProvider | undefined,
    nowMs: () => number,
    system: string,
    bound?: Record<string, unknown>,
  ): ScopedLogger | undefined {
    if (provider === undefined) return undefined;
    const level = provider.level(system);
    if (level === undefined) return undefined;
    return new ScopedLogger(provider, nowMs, system, level, bound);
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.log('debug', event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.log('info', event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.log('warn', event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.log('error', event, data);
  }

  child(name: string, data?: Record<string, unknown>): ScopedLogger | undefined {
    const bound = this.bound === undefined && data === undefined
      ? undefined
      : { ...this.bound, ...data };
    return ScopedLogger.create(this.provider, this.nowMs, `${this.system}.${name}`, bound);
  }

  /** True when an event at this level would be emitted; for guarding hot paths. */
  enabled(level: LogLevel): boolean {
    return LOG_ORDER[level] >= LOG_ORDER[this.minLevel];
  }

  private log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    const payload: LogEvent = {
      system: this.system,
      event,
      level,
      timestamp: this.nowMs(),
      data: this.bound === undefined ? data ?? {} : { ...this.bound, ...data },
    };
    this.provider.handle(payload);
  }
}
