import { LogEvent, LoggingProvider, LogLevel } from '../src/interfaces/LoggingProvider.ts';
import { jsonSafeStringify } from '../src/util/json.ts';
import { LevelFn, toLevelFn } from './logSpec.ts';

/**
 * One line per event, written through an injected sink -- the CLI points this
 * at stderr so diagnostics never contaminate stdout. Data is not abbreviated,
 * so full hashes stay greppable.
 */
export class TextLoggingProvider implements LoggingProvider {
  private levelFn: LevelFn;

  constructor(private write: (line: string) => void, level: string | LevelFn = 'info') {
    this.levelFn = toLevelFn(level);
  }

  level(system: string): LogLevel | undefined {
    return this.levelFn(system);
  }

  handle(event: LogEvent): void {
    const at = new Date(event.timestamp).toISOString();
    const tag = event.level.toUpperCase().padEnd(5);
    const data = Object.keys(event.data).length > 0 ? ' ' + jsonSafeStringify(event.data) : '';
    this.write(`${at} ${tag} ${event.system} ${event.event}${data}\n`);
  }
}
