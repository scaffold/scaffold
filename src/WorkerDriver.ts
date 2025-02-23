import { LogSystem } from './Config.ts';
import { Context } from './Context.ts';
import { Logger } from './Logger.ts';
import { WorkerRecordSet } from './record_sets/WorkerRecordSet.ts';
import { Resource } from './WorkerDriverService.ts';

export class WorkerDriver {
  log?: Logger;

  done = new AbortController();

  private startTime: number;
  private totalBlockedTime = 0;
  private pauses = 0;
  private pauseTime: undefined | number;

  constructor(private ctx: Context) {
    this.log = Logger.create(ctx, LogSystem.Worker);

    this.startTime = ctx.config.timeProvider.now();
  }

  setAllocation(resources: Partial<Record<Resource, number>>) {
    // TODO
    return Promise.resolve();
  }

  pauseTimer(why: string) {
    this.log?.debug(`Blocking due to ${why}...`, { timestamp: this.ctx.config.timeProvider.now() });
    if (this.pauses++ === 0) {
      if (this.pauseTime !== undefined) {
        throw new Error(`Internal error!`);
      }
      this.pauseTime = this.ctx.config.timeProvider.now();
    }

    this.ctx.maybeGet(WorkerRecordSet)?.dispatchUpdate(this);
  }
  resumeTimer(why: string) {
    this.log?.debug(`${why}; resuming...`, { timestamp: this.ctx.config.timeProvider.now() });
    if (--this.pauses === 0) {
      if (this.pauseTime === undefined) {
        throw new Error(`Cannot resume without pausing!`);
      }
      this.totalBlockedTime += this.ctx.config.timeProvider.now() - this.pauseTime;
      this.pauseTime = undefined;
    }

    this.ctx.maybeGet(WorkerRecordSet)?.dispatchUpdate(this);
  }

  getTotalTime() {
    return this.ctx.config.timeProvider.now() - this.startTime;
  }

  getCpuTime() {
    return (this.pauseTime ?? this.ctx.config.timeProvider.now()) - this.startTime -
      this.totalBlockedTime;
  }
}
