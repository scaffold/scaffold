import {
  LOG_ORDER,
  LogEvent,
  LoggingProvider,
  LogLevel,
} from '../src/interfaces/LoggingProvider.ts';

/**
 * Fans one event out to several sinks that may want different levels -- a
 * ring buffer at debug feeding a UI alongside a console at warn.
 *
 * `level` reports the loosest level any sink wants, because scaffold uses it
 * as the gate: anything stricter here would never reach `handle` to be
 * re-filtered per sink.
 */
export class MultiLoggingProvider implements LoggingProvider {
  private providers: LoggingProvider[];

  constructor(...providers: LoggingProvider[]) {
    this.providers = providers;
  }

  level(system: string): LogLevel | undefined {
    let loosest: LogLevel | undefined;
    for (const provider of this.providers) {
      const level = provider.level(system);
      if (level === undefined) continue;
      if (loosest === undefined || LOG_ORDER[level] < LOG_ORDER[loosest]) loosest = level;
    }
    return loosest;
  }

  handle(event: LogEvent): void {
    for (const provider of this.providers) {
      const level = provider.level(event.system);
      if (level !== undefined && LOG_ORDER[event.level] >= LOG_ORDER[level]) {
        provider.handle(event);
      }
    }
  }
}
