import { LogSystem } from './Config.ts';
import { Context } from './Context.ts';

export const enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  CRITICAL = 50,
}

export interface LogEvent {
  timestamp: number;
  level: LogLevel;
  message: string;
  data: { [key: string]: unknown };
}

export class Logger {
  public events: LogEvent[] = [];

  private constructor(private ctx: Context, public minLevel: LogLevel) {}

  static create(ctx: Context, system: LogSystem) {
    const level = ctx.config.logLevels[system];
    return level !== undefined ? new Logger(ctx, level) : undefined;
  }

  debug(message: string, data?: { [key: string]: unknown }) {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: { [key: string]: unknown }) {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: { [key: string]: unknown }) {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, data?: { [key: string]: unknown }) {
    this.log(LogLevel.ERROR, message, data);
  }

  critical(message: string, data?: { [key: string]: unknown }) {
    this.log(LogLevel.CRITICAL, message, data);
  }

  private log(level: LogLevel, message: string, data: { [key: string]: unknown } = {}) {
    if (level >= this.minLevel) {
      const event = { timestamp: this.ctx.config.timeProvider.now(), level, message, data };
      for (const provider of this.ctx.config.loggingProviders) {
        provider.handler(event);
      }
      this.events.push(event);
    }
  }
}
