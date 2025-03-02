import { assert } from '@std/assert/assert';
import { Context } from './Context.ts';
import { WorkerChannelServer } from './worker/WorkerChannel.ts';
import { InitialMsg, JobSpec, RunnerComm, WorkerComm } from './worker/workerTypes.ts';
import { DataTree } from './protocol/base.ts';

export interface Job {
  wasmModule: WebAssembly.Module;
  calls: string[];

  score(): number;
}

export interface InstanceFactory {
  createDriver(
    runner: RunnerComm,
    instanceId: number,
  ): WorkerComm & { run(job: Job): Promise<DataTree> };
}

export interface Runner {
  worker: Worker;
  server: WorkerChannelServer<WorkerComm>;
  isReady: boolean;
  // instIdx: number;
  // metas: StateMeta[];

  // lastPreempt: number;
  // stop: boolean;
}

interface Instance {
  memory: number;
}

interface EnqueuedJob {
  job: Job;
  instanceFactory: InstanceFactory;
  resolve(tree: DataTree): void;
  reject(): void;
}

export class WorkerManager {
  private runners: Runner[] = [];
  private instances: Instance[] = [];
  private enqueuedJobs: EnqueuedJob[] = [];

  private nextInstanceId = 0;

  constructor(private ctx: Context) {
    if (this.ctx.config.workerPath === undefined) {
      throw new Error(
        `You must set the workerPath in config to execute WASM computations!`,
      );
    }
  }

  run(instanceFactory: InstanceFactory, job: Job) {
    let runner = this.runners.find((runner) => runner.isReady);
    if (runner === undefined) {
      if (this.runners.length < 4) {
        runner = this.startRunner();
      } else {
        const { promise, resolve, reject } = Promise.withResolvers<DataTree>();
        this.enqueuedJobs.push({ job, instanceFactory, resolve, reject });
        return promise;
      }
    }
    return this.launchJob(runner, instanceFactory, job);
  }

  private startRunner() {
    const worker = new Worker(this.ctx.config.workerPath!, {
      type: 'module',
      // deno: {
      //   namespace: false,
      //   permissions: {
      //     env: false,
      //     hrtime: false,
      //     net: false,
      //     ffi: false,
      //     read: false,
      //     run: false,
      //     write: false,
      //   },
      // },
    });

    const sigBuf = new SharedArrayBuffer(8);
    const msg: InitialMsg = { type: 'init', sigBuf };
    worker.postMessage(msg);

    const runner: Runner = {
      worker,
      server: new WorkerChannelServer<WorkerComm>(worker, sigBuf),
      isReady: true,
    };
    this.runners.push(runner);

    return runner;
  }

  private launchJob(runner: Runner, instanceFactory: InstanceFactory, job: Job) {
    assert(runner.isReady);

    const driver = instanceFactory.createDriver(runner.worker, this.nextInstanceId);
    runner.server.createChannel(this.nextInstanceId++, driver);

    runner.isReady = false;
    return driver.run(job).finally(() => {
      runner.isReady = true;

      const bestJob = this.findBestJob(runner);
      if (bestJob !== undefined) {
        this.launchJob(runner, bestJob.instanceFactory, bestJob.job)
          .then(bestJob.resolve, bestJob.reject);
      }
    });
  }

  private findBestJob(runner: Runner) {
    if (this.enqueuedJobs.length === 0) {
      return undefined;
    }

    let bestJob = this.enqueuedJobs[0];
    let bestScore = bestJob.job.score();
    for (let i = 1; i < this.enqueuedJobs.length; i++) {
      const score = this.enqueuedJobs[i].job.score();
      if (score > bestScore) {
        bestJob = this.enqueuedJobs[i];
        bestScore = score;
      }
    }

    return bestJob;
  }
}
