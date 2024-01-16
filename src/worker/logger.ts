import { log } from '../../deps.ts';

// const logger: Logger = {
//   info: (data, msg) => console.log(data, msg),
//   warn: (data, msg) => console.warn(data, msg),
//   error: (data, msg) => console.error(data, msg),
// };
const formatter: log.FormatterFunction = (logRecord) =>
  `${logRecord.levelName} ${logRecord.msg} ${
    logRecord.args.map((a) =>
      JSON.stringify(a, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value)
    ).join(',')
  }`;

const consoleHandler = new log.handlers.ConsoleHandler('DEBUG', { formatter });
const fileHandler = new log.handlers.FileHandler('DEBUG', {
  filename: `/tmp/sbl_worker_${Date.now()}_${
    Math.random().toString(36).slice(2)
  }.log`,
  formatter,
});
log.setup({
  handlers: { console: consoleHandler, file: fileHandler },

  loggers: {
    worker: {
      level: 'DEBUG',
      handlers: ['console', 'file'],
    },
  },
});
setInterval(() => fileHandler.flush(), 1000);

export default log.getLogger('worker');
