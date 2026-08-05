import { assert } from '../../util/functional.ts';
import { SIG_BUF_BYTES } from './WorkerChannel.ts';

export interface PooledWorker {
  worker: Worker;
  sigBuf: SharedArrayBuffer;
  stagingBuf: SharedArrayBuffer;
}

/** Unbounded: ExecutionQueue above is the load-bearing concurrency limit, so
 * this only reuses idle workers and never queues or caps. */
export class WasmWorkerPool {
  private free: PooledWorker[] = [];
  private live = new Set<PooledWorker>();
  private closed = false;

  constructor(private workerUrl: URL, private stagingBytes: number) {}

  acquire(): PooledWorker {
    assert(!this.closed, 'worker pool is closed');
    const existing = this.free.pop();
    if (existing !== undefined) return existing;

    const worker = new Worker(this.workerUrl, { type: 'module' });
    const sigBuf = new SharedArrayBuffer(SIG_BUF_BYTES);
    const stagingBuf = new SharedArrayBuffer(this.stagingBytes);
    worker.postMessage({ type: 'init', sigBuf, stagingBuf });
    const pooled: PooledWorker = { worker, sigBuf, stagingBuf };
    this.live.add(pooled);
    return pooled;
  }

  release(pooled: PooledWorker): void {
    pooled.worker.onmessage = null;
    pooled.worker.onerror = null;
    if (this.closed) {
      this.discard(pooled);
    } else {
      this.free.push(pooled);
    }
  }

  /** For workers in an unknown state (killed or faulted): terminated, never reused. */
  discard(pooled: PooledWorker): void {
    this.live.delete(pooled);
    pooled.worker.terminate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pooled of this.live) pooled.worker.terminate();
    this.live.clear();
    this.free.length = 0;
  }
}
