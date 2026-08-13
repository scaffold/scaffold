import { BaseContext } from './util/BaseContext.ts';
import { ScopedLogger } from './logic/Logger.ts';
import { Config } from './Config.ts';

export class Context extends BaseContext {
  constructor(public config: Config) {
    super();
  }

  /**
   * Scoped logger for a subsystem, or undefined when logging is off for it --
   * hold the result and call it as `logger?.info(...)` so a disabled subsystem
   * never builds a message. Read `config.loggingProvider` lazily, so a logger
   * taken before the provider is set will not see it.
   */
  logger(system: string): ScopedLogger | undefined {
    return ScopedLogger.create(
      this.config.loggingProvider,
      () => this.config.timeProvider.nowMs(),
      system,
    );
  }
}
