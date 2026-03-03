import { LogSystem } from './Config.ts';
import { Context } from './Context.ts';
import { Logger } from './Logger.ts';
import { WorkerRecordSet } from './record_sets/WorkerRecordSet.ts';
import { mapEntries } from './util/functional.ts';

export enum Resource {
  Time = 'time',
  WebWorkerCount = 'webWorkerCount',
  CpuUsage = 'cpuUsage',
  MemoryMb = 'memoryMb',
}

export class WorkerDriver {
  log?: Logger;

  #done = new AbortController();

  // #allocation: { [key in Resource]: number };

  #startTime: number;
  #totalBlockedTime = 0;
  #pauses = 0;
  #pauseTime: undefined | number;

  constructor(public ctx: Context, private scoreFn: () => number) {
    this.log = Logger.create(ctx, LogSystem.Worker);

    // this.allocation = mapEntries(this.ctx.config.resourceLimits, (_k, _v) => 0);

    this.#startTime = ctx.config.timeProvider.now();

    if (this.log !== undefined) {
      this.#done.signal.addEventListener('abort', () => this.log!.info('Aborted!'));
    }
  }

  // This should be called at regular intervals and when new resources are requested, to give the driver a chance to pause or kill the job
  allocate(resourceType: Resource, amount: number) {
    // TODO
    return Promise.resolve({ [Symbol.dispose]() {} });
  }

  getDoneSignal() {
    return this.#done.signal;
  }

  finish(err?: Error) {
    if (err === undefined) {
      this.log?.info('Passed!');
    } else {
      this.log?.warn(`Failed: ${err}`, { err });
    }

    this.ctx.maybeGet(WorkerRecordSet)?.dispatchUpdate(this);

    this.#done.abort(err);
    // this.allocated.webWorkerCount -= allocation.webWorkerCount;
    // this.resume();
  }

  pauseTimer(why: string) {
    this.log?.debug(`Blocking due to ${why}...`);
    if (this.#pauses++ === 0) {
      if (this.#pauseTime !== undefined) {
        throw new Error(`Internal error!`);
      }
      this.#pauseTime = this.ctx.config.timeProvider.now();
    }

    this.ctx.maybeGet(WorkerRecordSet)?.dispatchUpdate(this);
  }
  resumeTimer(why: string) {
    this.log?.debug(`${why}; resuming...`);
    if (--this.#pauses === 0) {
      if (this.#pauseTime === undefined) {
        throw new Error(`Cannot resume without pausing!`);
      }
      this.#totalBlockedTime += this.ctx.config.timeProvider.now() - this.#pauseTime;
      this.#pauseTime = undefined;
    }

    this.ctx.maybeGet(WorkerRecordSet)?.dispatchUpdate(this);
  }

  getTotalTime() {
    return this.ctx.config.timeProvider.now() - this.#startTime;
  }

  getCpuTime() {
    return (this.#pauseTime ?? this.ctx.config.timeProvider.now()) -
      this.#startTime - this.#totalBlockedTime;
  }
}
