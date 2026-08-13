// deno-lint-ignore-file no-console

import { LogEvent, LoggingProvider, LogLevel } from '../src/interfaces/LoggingProvider.ts';
import { LevelFn, toLevelFn } from './logSpec.ts';
import { shortenHashes } from './util.ts';

/** Styled console output, for a browser host. Shell hosts want TextLoggingProvider. */
export class ConsoleLoggingProvider implements LoggingProvider {
  private levelFn: LevelFn;

  constructor(level: string | LevelFn = 'info') {
    this.levelFn = toLevelFn(level);
  }

  level(system: string): LogLevel | undefined {
    return this.levelFn(system);
  }

  handle(event: LogEvent): void {
    const fn = event.level === 'error'
      ? console.error
      : event.level === 'warn'
      ? console.warn
      : event.level === 'debug'
      ? console.debug
      : console.info;
    fn(
      `%c${event.system}%c ${event.event}`,
      'color: #888; font-weight: bold',
      'color: inherit; font-weight: normal',
      shortenHashes(event.data),
    );
  }
}
