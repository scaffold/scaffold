/*
High-recursion contracts:
  Kill the original contracts; resume them if inputs are satisfied

Executions optionally consume N resources (workers)

Fixed worker pool
  To kill worker, wait 1 second until it blocks and throw, or else terminate.
  Kill if we have a missing input, and subscribe to the input to re-enqueue if the input becomes available.
*/

import { BlockExt } from './BlockMeta.ts';
import Context from './Context.ts';
import FetchService from './FetchService.ts';
import Logger from './Logger.ts';
import { Verifier } from './messages.ts';
import { arrEquals } from './util/buffer.ts';
import { mapEntries } from './util/functional.ts';
import { INTERRUPT_FLAG } from './worker/WorkerChannel.ts';

export const enum Resource {
  WebWorkerCount = 'webWorkerCount',
  CpuUsage = 'cpuUsage',
  MemoryMb = 'memoryMb',
}

export interface ExecutorDriver {
  setAllocation(resources: Partial<Record<Resource, number>>): Promise<void>;
  request(verifier: Verifier): Promise<Uint8Array>;
  notify(verifier: Verifier): void;
  fulfills(block: BlockExt, outputIdx: number): void;
  getInputs(): { block: BlockExt; outputIdx: number }[];
  getTotalTime(): number;
  getCpuTime(): number;
}

interface WorkEntry {
  // After a while of having a non-canonical input (or maybe some other weight-based threshold), remove from queue
  inputs: { block: BlockExt; outputIdx: number }[];
  getScore(): number;
  continuation(): void;
}

// interface EventLogEntry {
//   time: number;
//   type: 'requestBegin' | 'requestEnd' | 'notify';
//   verifier: Verifier;
// }

const logScoreAccuracy = 0.1;

export default class ExecutorDriverService {
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
    verifier: Verifier,
    tags: Record<string, Uint8Array>,
    getScore: () => number, // Distribution, or uncertainty, or variance/time?
    launch: (
      driver: ExecutorDriver,
      cancel: Promise<typeof INTERRUPT_FLAG>, // If cancel fulfills, reject the outer promise
    ) => Promise<void>,
  ) /* TODO: Return a setScore(score: number) method so we can update from block update? Probably need to start implementing the launcher to determine this. */ {
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

    const inputs: { block: BlockExt; outputIdx: number }[] = [];
    const releases: (() => void)[] = [];

    const startTime = this.ctx.config.timeProvider.now();
    let blockedTime = 0;
    let blockedCount = 0;

    let cancelResolver: (_: typeof INTERRUPT_FLAG) => void;
    const cancelPromise = new Promise<typeof INTERRUPT_FLAG>((resolve) =>
      cancelResolver = resolve
    );

    let running = true;
    const stop = (success: boolean) => {
      if (running) {
        running = false;
        releases.forEach((cb) => cb());
        this.allocated.webWorkerCount -= allocation.webWorkerCount;
        this.resume();
        if (!success) {
          throw new Error(
            `ExecutorDriverService.run launch failed! Not restarting...`,
          );
          // TODO: Do we need to restart here?
          // this.run(verifier, tags, getScore, launch);
        }
      }
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

    launch({
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
            if (blockedCount++ === 0) {
              blockedTime -= this.ctx.config.timeProvider.now();
            }

            this.workerQueue.push({
              inputs,
              getScore,
              continuation: () => {
                if (--blockedCount === 0) {
                  blockedTime += this.ctx.config.timeProvider.now();
                }

                resolve();
              },
            });
          });
        }
      },
      request: (verifier) =>
        new Promise((reply) => {
          if (!running) {
            return;
          }

          if (blockedCount++ === 0) {
            blockedTime -= this.ctx.config.timeProvider.now();
          }

          // TODO: Call pause/resume when requesting?
          const idx = inputs.length;
          const { release } = this.ctx.get(FetchService).fetch(
            verifier,
            {},
            (block) => {
              this.ctx.get(Logger).info('got req', { verifier, block });

              // TODO: If we get a non-canonical block (canonicality <= 0), we have to check if it's mergeable with the other inputs (positive and negative).
              // If it's not, or maybe just in any case of not having a canonical input:
              //   Any block can be made canonical by re-writing, and not claiming the disputed input(s).

              if (inputs.length === idx) {
                inputs.push({ block, outputIdx: -1 });
                if (--blockedCount === 0) {
                  blockedTime += this.ctx.config.timeProvider.now();
                }
                reply(block.body);
              } else if (arrEquals(inputs[idx].block.body, block.body)) {
                // TODO: What to do here?
                inputs[idx].block = block;
              } else {
                stop(false);
                cancelResolver(INTERRUPT_FLAG);

                // TODO: Remove our entries from workerQueue, which will make them never resolve
              }
            },
          );
          releases.push(release);
        }),
      notify: (verifier) => this.ctx.get(FetchService).fetch(verifier, {}),
      fulfills: (block: BlockExt, outputIdx: number) =>
        inputs.push({ block, outputIdx }),
      getInputs: () => inputs,
      getTotalTime: () => this.ctx.config.timeProvider.now() - startTime,
      getCpuTime: () =>
        this.ctx.config.timeProvider.now() - startTime -
        (blockedCount
          ? blockedTime + this.ctx.config.timeProvider.now()
          : blockedTime),
    }, cancelPromise).then(
      () => stop(true),
      (err) => {
        if (err !== INTERRUPT_FLAG) {
          console.error(err);
        }
        stop(false);
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
