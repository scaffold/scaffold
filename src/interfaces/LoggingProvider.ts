import { LogEvent } from './logging.ts';

export interface LoggingProvider {
  handler(event: LogEvent, ctx: unknown): void;
}
