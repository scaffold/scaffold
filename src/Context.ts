import { BaseContext } from './util/BaseContext.ts';
import { EventLog, ScopedLogger } from './core/EventLog.ts';
import { Config } from './Config.ts';

export class Context extends BaseContext {
  readonly eventLog?: EventLog;

  constructor(public config: Config, eventLog?: EventLog) {
    super();
    this.eventLog = eventLog;
  }

  /** Get a scoped logger for the given subsystem, or undefined if no EventLog is set. */
  logger(system: string): ScopedLogger | undefined {
    return this.eventLog ? new ScopedLogger(this.eventLog, system) : undefined;
  }
}
