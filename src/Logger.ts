import { LogSystem } from './Config.ts';
import { Context } from './Context.ts';

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  CRITICAL = 50,
}

export interface LogEvent {
  system: LogSystem;
  timestamp: number;
  level: LogLevel;
  message: string;
  data: unknown;
}

export class Logger {
  // private events: LogEvent[] = [];

  private constructor(
    private ctx: Context,
    private system: LogSystem,
    private minLevel: LogLevel,
  ) {}

  static create(ctx: Context, system: LogSystem) {
    const level = ctx.config.logLevels[system];
    return level !== undefined ? new Logger(ctx, system, level) : undefined;
  }

  debug(message: string, data?: unknown) {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: unknown) {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: unknown) {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, data?: unknown) {
    this.log(LogLevel.ERROR, message, data);
  }

  critical(message: string, data?: unknown) {
    this.log(LogLevel.CRITICAL, message, data);
  }

  log(level: LogLevel, message: string, data?: unknown) {
    if (level >= this.minLevel) {
      const event = {
        system: this.system,
        timestamp: this.ctx.config.timeProvider.now(),
        level,
        message,
        data,
      };
      for (const provider of this.ctx.config.loggingProviders) {
        provider.handler(event, this.ctx);
      }
      // this.events.push(event);
    }
  }
}
