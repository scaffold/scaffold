/*
High-recursion contracts:
  Kill the original contracts; resume them if inputs are satisfied

Executions optionally consume N resources (workers)

Fixed worker pool
  To kill worker, wait 1 second until it blocks and throw, or else terminate.
  Kill if we have a missing input, and subscribe to the input to re-enqueue if the input becomes available.
*/

import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import { mapEntries } from './util/functional.ts';

// TODO: Use input monitoring to prevent blocking the main thread?
// https://developer.mozilla.org/en-US/docs/Web/API/Scheduling/isInputPending

export const WORKER_FAIL_FLAG = Symbol('WorkerDriver.Fail');
export const WORKER_RETRY_FLAG = Symbol('WorkerDriver.Retry');

export const enum Resource {
  WebWorkerCount = 'webWorkerCount',
  CpuUsage = 'cpuUsage',
  MemoryMb = 'memoryMb',
}

export interface LogEntry {
  timestamp: number;
  message: string;
}

export interface WorkerDriver {
  setAllocation(resources: Partial<Record<Resource, number>>): Promise<void>;

  log?: LogEntry[];

  done: AbortController;

  pauseTimer(why: string): void;
  resumeTimer(): void;

  getTotalTime(): number;
  getCpuTime(): number;
}

interface WorkEntry {
  // After a while of having a non-canonical input (or maybe some other weight-based threshold), remove from queue
  // inputs: InputSpec[];
  getScore(): number;
  continuation(): void;
}

// interface EventLogEntry {
//   time: number;
//   type: 'requestBegin' | 'requestEnd' | 'notify';
//   verifier: Verifier;
// }

const logScoreAccuracy = 0.1;

export default class WorkerDriverService {
  private allocated: Record<Resource, number>;

  private workerQueue: WorkEntry[] = [];

  // Past compute time is a sunk cost.
  // Weigh pending and running computations by Expected[reward(remaining_cpu_time) / remaining_cpu_time * acceptance_probability(reward, remaining_cpu_time + remaining_blocking_time)]
  // ^ This is a way to compare executions wrt. CPU time, which is likely a limit. But for times when # of workers or memory is the limit, we need to handle that case too.
  // Schedule executions that maximize expected reward, constrained by resource usage.

  // Don't have a sharp cut-off on recursion distance, but:
  //   Without any external incentive, represent its score as some factor of the requesting score. Note that the remaining_cpu_time and remaining_blocking_time should be increased to calculate the child as well.

  constructor(private ctx: Context) {
    this.allocated = mapEntries(ctx.config.resourceLimits, (_k, _v) => 0);
  }

  public run(
    launch: (driver: WorkerDriver) => Promise<void>,
    getScore: () => number, // Expected profit/ms
  ) /* TODO: Return a setScore(score: number) method so we can update from block update? Probably need to start implementing the launcher to determine this. */ {
    const log = this.ctx.config.enableWorkerLogging
      ? [{
        timestamp: this.ctx.config.timeProvider.now(),
        message: 'Started worker',
      }]
      : undefined;

    const allocation = mapEntries(
      this.ctx.config.resourceLimits,
      (_k, _v) => 0,
    );

    // let lastLogScore = 0;
    // let runningAvgSqSlope = 0;
    // let rescoreInterval = 1000;
    // const updateScore = () => {
    //   const newLogScore = Math.log(getScore());
    //   // Also need to include the probability that the already-used inputs are correct
    //   const slope = (newLogScore - lastLogScore) / rescoreInterval;
    //   lastLogScore = newLogScore;
    //   runningAvgSqSlope = runningAvgSqSlope * 0.99 + slope * slope * 0.01;
    //   rescoreInterval = logScoreAccuracy / Math.sqrt(runningAvgSqSlope);
    //   if (rescoreInterval < 100) {
    //     rescoreInterval = 100;
    //   } else if (rescoreInterval > 10000) {
    //     rescoreInterval = 10000;
    //   }
    //   ctx.config.timeProvider.setTimeout(updateScore, rescoreInterval);
    // };
    // updateScore();

    const done = new AbortController();

    const startTime = this.ctx.config.timeProvider.now();
    let totalBlockedTime = 0;
    let pauseTime: undefined | number;
    const pauseTimer = (why: string) => {
      log?.push({
        timestamp: this.ctx.config.timeProvider.now(),
        message: `Blocking due to ${why}...`,
      });
      pauseTime ??= this.ctx.config.timeProvider.now();
    };
    const resumeTimer = () => {
      log?.push({
        timestamp: this.ctx.config.timeProvider.now(),
        message: `Resuming...`,
      });
      if (pauseTime === undefined) {
        throw new Error(`Cannot resume without pausing!`);
      }
      totalBlockedTime += this.ctx.config.timeProvider.now() - pauseTime;
      pauseTime = undefined;
    };

    // TODO: Maybe:
    // Represent computations as blocks - if an input becomes non-canonical, try to rescue by using another equivalent input, else we may have an opportunity descending from an unclaimed input with higher canonicality. This prevents keeping thousands of callbacks.
    // I don't think we need this - callbacks are just as much memory as blocks.
    // If a generator's first request is verifier V, then add a listener for new V blocks that enqueue a possible generation.
    // On adding a new block with verifier V, find other blocks derived from V, and possibly re-compute.

    /*
    When a block's weight changes:
      If it exceeds the weight of the previously heaviest block, OR becomes lighter than the weight of the second-heaviest block (both with the same verifier):
        let canonical_block = the new heaviest block
        let previous_block = the previous heaviest block
        Update block listeners
        If block.data changes:
          Update data listeners
          Foreach block using previous_block as input:
            Enqueue a re-generation
        Else:
          Foreach block using previous_block as input:
            Re-write using canonical_block as input (no need to re-generate)
    */

    return launch({
      setAllocation: (resources) => {
        // TODO: On cancel, kill this promise (never resolve or reject)
        // Right now we just deal with worker count
        // TODO: Deal with cpu/memory usage
        if (resources.webWorkerCount === undefined) {
          return Promise.resolve();
        }
        const prevWorkerCount = allocation.webWorkerCount;
        const newWorkerCount = resources.webWorkerCount;
        allocation.webWorkerCount = newWorkerCount;
        if (newWorkerCount <= prevWorkerCount) {
          this.allocated.webWorkerCount += newWorkerCount - prevWorkerCount;
          this.resume();
          return Promise.resolve();
        }

        if (newWorkerCount !== prevWorkerCount + 1) {
          throw new Error(`Unhandled case`);
        }

        if (
          this.allocated.webWorkerCount <
            this.ctx.config.resourceLimits.webWorkerCount
        ) {
          this.allocated.webWorkerCount++;
          return Promise.resolve();
        } else {
          return new Promise((resolve) => {
            pauseTimer('setAllocation()');

            this.workerQueue.push({
              // inputs,
              getScore,
              continuation: () => {
                resumeTimer();
                resolve();
              },
            });
          });
        }
      },

      log,

      done,

      pauseTimer,
      resumeTimer,

      getTotalTime: () => this.ctx.config.timeProvider.now() - startTime,
      getCpuTime: () =>
        (pauseTime ?? this.ctx.config.timeProvider.now()) -
        startTime - totalBlockedTime,
    }).then(
      () => {
        done.abort();
        this.allocated.webWorkerCount -= allocation.webWorkerCount;
        this.resume();
      },
      (err) => {
        if (err === WORKER_FAIL_FLAG) {
          console.error(
            `WorkerDriverService.run launch failed! Not restarting...`,
          );
        } else if (err === WORKER_RETRY_FLAG) {
          console.error(`WorkerDriverService.run needs to restart...`);
          // TODO: Restart here
          // this.run(verifier, tags, getScore, launch);
        } else {
          console.error(err);
        }

        done.abort(err);
        this.allocated.webWorkerCount -= allocation.webWorkerCount;
        this.resume();
      },
    );
  }

  private resume() {
    const threshold = this.ctx.config.resourceLimits.webWorkerCount;
    while (
      this.allocated.webWorkerCount < threshold && this.workerQueue.length
    ) {
      this.allocated.webWorkerCount++;

      let bestIdx = 0;
      let bestScore = this.workerQueue[0].getScore();
      for (let i = 1; i < this.workerQueue.length; i++) {
        const score = this.workerQueue[i].getScore();
        if (score > bestScore) {
          bestIdx = i;
          bestScore = score;
        }
      }

      if (bestScore < this.ctx.config.workScoreThreshold) {
        this.ctx.config.timeProvider.setTimeout(this.resume, 100);
        break;
      }

      const { continuation } = this.workerQueue[bestIdx];
      this.ctx.config.timeProvider.setTimeout(continuation, 0);

      // Note that this works even if the queue only has one entry
      this.workerQueue[bestIdx] = this.workerQueue[this.workerQueue.length - 1];
      this.workerQueue.length--;
    }
  }

  public snapshot() {
    return { allocated: this.allocated, workerQueue: this.workerQueue };
  }
}
