import { Context } from './Context.ts';
import { Hash } from './util/Hash.ts';
import { bin2hex } from './util/hex.ts';
import * as log from '@std/log';

const sortKeys = (obj: { [key: string]: any }) =>
  Object.fromEntries(
    Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])),
  );

const trim = (str: string, maxLen: number) =>
  str.length > maxLen ? `${str.substring(0, maxLen)}... [${str.length}]` : str;

const formatter: log.FormatterFunction = (logRecord: log.LogRecord) =>
  `${logRecord.levelName} ${logRecord.loggerName} ${logRecord.msg} ${logRecord.args[0]}`;

const logConfig: log.LogConfig & { loggers: Record<string, log.LoggerConfig> } = {
  handlers: {
    console: new log.ConsoleHandler('DEBUG', { formatter }),
    // file: new log.handlers.FileHandler('DEBUG', {
    //   filename: `/tmp/sbl_${Date.now()}_${
    //     Math.random().toString(36).slice(2)
    //   }.log`,
    //   formatter,
    // }),
  },
  loggers: {},
};

export class Logger {
  private setupPromise: void; // Promise<void>;
  constructor(private ctx: Context) {
    logConfig.loggers[`sbl_${ctx.config.debugName}`] = {
      level: log.getLevelName(ctx.config.logLevel),
      handlers: [
        'console',
        // 'file',
      ],
    };

    this.setupPromise = log.setup(logConfig);
  }

  private get() {
    return log.getLogger(`sbl_${this.ctx.config.debugName}`);
  }

  public async debug(msg: string, params: { [key: string]: any }) {
    console.log('DEBUG', this.ctx.config.debugName, msg, params);
    // const serializedParams = this.serialize(params);
    // await this.setupPromise;
    // return this.get().debug(msg, serializedParams);
  }
  public async info(msg: string, params: { [key: string]: any }) {
    console.log('INFO', this.ctx.config.debugName, msg, params);
    // const serializedParams = this.serialize(params);
    // await this.setupPromise;
    // return this.get().info(msg, serializedParams);
  }
  public async warning(msg: string, params: { [key: string]: any }) {
    console.log('WARNING', this.ctx.config.debugName, msg, params);
    // const serializedParams = this.serialize(params);
    // await this.setupPromise;
    // return this.get().warning(msg, serializedParams);
  }
  public async error(msg: string, params: { [key: string]: any }) {
    console.log('ERROR', this.ctx.config.debugName, msg, params);
    // const serializedParams = this.serialize(params);
    // await this.setupPromise;
    // return this.get().error(msg, serializedParams);
  }
  public async critical(msg: string, params: { [key: string]: any }) {
    console.log('CRITICAL', this.ctx.config.debugName, msg, params);
    // const serializedParams = this.serialize(params);
    // await this.setupPromise;
    // return this.get().critical(msg, serializedParams);
  }
}
