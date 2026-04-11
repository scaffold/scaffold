import { BaseContext } from '../util/BaseContext.ts';
import { EventLog, ScopedLogger } from './EventLog.ts';

/** Lean DI container for the protocol layer. Services register via ctx.get(ServiceClass). */
export class ProtocolContext extends BaseContext<ProtocolContext> {
  readonly eventLog?: EventLog;

  constructor(eventLog?: EventLog) {
    super();
    this.eventLog = eventLog;
  }

  /** Get a scoped logger for the given subsystem, or undefined if no EventLog is set. */
  logger(system: string): ScopedLogger | undefined {
    return this.eventLog ? new ScopedLogger(this.eventLog, system) : undefined;
  }

  protected override getThis(): ProtocolContext {
    return this;
  }
}
