// Protocol spec: docs/protocol/wasm-abi.md
//
// Port of `legacy2/WorkerManager.ts`. Owns up to `poolSize` workers; each
// pending job carries a `score()` and the pool dispatches the highest-
// scoring queued job when a worker becomes ready. Stripped of the legacy
// DataTree-specific bits; jobs return arbitrary values (the transport
// layer above interprets them).

import {
  SIG_BUF_SIZE,
  STAGING_DEFAULT_SIZE,
  WasmWorkerChannelServer,
} from '../../worker/wasm/WasmWorkerChannel.ts';

export interface WasmPoolJob<R> {
  /** Higher score = dispatched sooner when multiple jobs are queued. */
  score(): number;
  /** Drive one job to completion on the given worker. */
  run(worker: WasmPoolWorker): Promise<R>;
}

export interface WasmPoolWorker {
  readonly worker: Worker;
  readonly server: WasmWorkerChannelServer;
  readonly sigBuf: SharedArrayBuffer;
  readonly stagingBuf: SharedArrayBuffer;
}

interface InternalWorker extends WasmPoolWorker {
  isReady: boolean;
}

interface EnqueuedJob<R> {
  job: WasmPoolJob<R>;
  resolve(value: R): void;
  reject(reason: unknown): void;
}

export interface WasmWorkerPoolConfig {
  workerPath: string | URL;
  poolSize?: number;
  stagingBufSize?: number;
}

export class WasmWorkerPool {
  private readonly workerPath: string | URL;
  private readonly poolSize: number;
  private readonly stagingBufSize: number;
  private readonly workers: InternalWorker[] = [];
  private readonly queue: EnqueuedJob<unknown>[] = [];
  private closed = false;

  constructor(config: WasmWorkerPoolConfig) {
    this.workerPath = config.workerPath;
    this.poolSize = config.poolSize ?? 4;
    this.stagingBufSize = config.stagingBufSize ?? STAGING_DEFAULT_SIZE;
  }

  submit<R>(job: WasmPoolJob<R>): Promise<R> {
    if (this.closed) {
      return Promise.reject(new Error('WasmWorkerPool is closed'));
    }
    let worker = this.workers.find((w) => w.isReady);
    if (worker === undefined) {
      if (this.workers.length < this.poolSize) {
        worker = this.startWorker();
      } else {
        let resolve!: (value: R) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<R>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        this.queue.push({
          job: job as WasmPoolJob<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        return promise;
      }
    }
    return this.launch(worker, job);
  }

  // deno-lint-ignore require-await
  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.workers) {
      try {
        w.worker.postMessage({ type: 'exit' });
        w.worker.terminate();
      } catch {
        // Swallow -- shutdown is best-effort.
      }
    }
    this.workers.length = 0;
    // Reject any pending queued jobs.
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      queued?.reject(new Error('WasmWorkerPool closed'));
    }
  }

  private startWorker(): InternalWorker {
    const worker = new Worker(this.workerPath, { type: 'module' });
    const sigBuf = new SharedArrayBuffer(SIG_BUF_SIZE);
    const stagingBuf = new SharedArrayBuffer(this.stagingBufSize);
    worker.postMessage({ type: 'init', sigBuf, stagingBuf });
    const server = new WasmWorkerChannelServer(worker, sigBuf, stagingBuf);
    const entry: InternalWorker = {
      worker,
      server,
      sigBuf,
      stagingBuf,
      isReady: true,
    };
    this.workers.push(entry);
    return entry;
  }

  private async launch<R>(worker: InternalWorker, job: WasmPoolJob<R>): Promise<R> {
    worker.isReady = false;
    try {
      return await job.run(worker);
    } finally {
      worker.isReady = true;
      this.drainQueue(worker);
    }
  }

  private drainQueue(worker: InternalWorker): void {
    if (this.queue.length === 0 || !worker.isReady) return;
    let bestIdx = 0;
    let bestScore = this.queue[0].job.score();
    for (let i = 1; i < this.queue.length; i++) {
      const s = this.queue[i].job.score();
      if (s > bestScore) {
        bestIdx = i;
        bestScore = s;
      }
    }
    const next = this.queue.splice(bestIdx, 1)[0];
    this.launch(worker, next.job).then(next.resolve, next.reject);
  }
}
