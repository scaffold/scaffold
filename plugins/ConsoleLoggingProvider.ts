// deno-lint-ignore-file no-console

import { LoggingProvider } from '../src/interfaces/LoggingProvider.ts';
import { LogEvent, LogLevel } from '../src/interfaces/logging.ts';

export class ConsoleLoggingProvider implements LoggingProvider {
  handler(event: LogEvent) {
    const at = new Date(event.timestamp).toISOString();
    switch (event.level) {
      case LogLevel.DEBUG:
        console.debug(at, event.message, event.data);
        break;
      case LogLevel.INFO:
        console.info(at, event.message, event.data);
        break;
      case LogLevel.WARN:
        console.warn(at, event.message, event.data);
        break;
      case LogLevel.ERROR:
        console.error(at, event.message, event.data);
        break;
      case LogLevel.CRITICAL:
        console.error('FATAL', at, event.message, event.data);
        break;
    }
  }
}
