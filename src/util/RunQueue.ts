import { Logger } from '../interfaces/LoggingProvider.ts';
import { arrCall } from './array.ts';
import { assert, error } from './functional.ts';
import { MaybePromise } from './MaybePromise.ts';

export interface RunQueueConfig {
  maxRunning: number;
  maxYielding: number;
}

export class CancelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelError';
  }
}

export interface Job<ResultType = unknown> {
  priority(): number; // Higher values run first
  run(ctl: FlowCtl): Promise<ResultType>; // Should not throw, except for `CancelError`
}

export interface FlowCtl {
  signal: AbortSignal; // Do we even need this or should we expect jobs to preemptively yield?
  yield(): MaybePromise<void>;
}

export enum JobState {
  Pending,
  Yielding,
  Running,
  Completed,
  Removed,
}

export interface JobCounts {
  [JobState.Pending]: number;
  [JobState.Yielding]: number;
  [JobState.Running]: number;
  [JobState.Completed]: number;
  [JobState.Removed]: number;
}

interface JobHandle {
  state: JobState;
  cancel?: AbortController;
  userSignal?: AbortSignal;
  onDone(result: unknown): void;
  onError(error: unknown): void;
}

/*
An execution queue that orders jobs by priority.
The caller should manage job lifetimes and remove them after the run() call resolves.
Assuming jobs call yield() frequently enough:
  When ordered by priority, the top maxRunning jobs will be running (not blocked in a yield call) at any given time.
  When ordered by priority, the top maxRunning+maxYielding jobs will be either running or yielding at any given time.
  All running lower-priority jobs will be cancelled by aborting their provided signal and throwing CancelError if blocked in a yield call. They will be moved back to the pending state.
In all cases, the number of jobs in those states will be limited by the thresholds.
*/
export class RunQueue implements Disposable {
  private jobs = new Map<Job, JobHandle>();
  private counts: JobCounts = {
    [JobState.Pending]: 0,
    [JobState.Yielding]: 0,
    [JobState.Running]: 0,
    [JobState.Completed]: 0,
    [JobState.Removed]: 0,
  };
  private countsListeners = new Set<(counts: JobCounts) => void>();

  constructor(private config: RunQueueConfig, private log: Logger | undefined) {}

  run<ResultType>(job: Job<ResultType>, signal?: AbortSignal): Promise<ResultType> {
    assert(!this.jobs.has(job));
    return new Promise((resolve, reject) => {
      this.jobs.set(job, {
        state: JobState.Pending,
        userSignal: signal,
        onDone: resolve,
        onError: reject,
      });
      this.counts[JobState.Pending]++;
      arrCall(this.countsListeners, this.log, this.counts);
      this.dispatch();
    });
  }

  getState(job: Job): JobState {
    return (this.jobs.get(job) ?? error('Job not found')).state;
  }

  remove(job: Job): void {
    const entry = this.jobs.get(job) ?? error('Job not found');
    entry.cancel?.abort();
    this.counts[entry.state]--;
    this.counts[JobState.Removed]++;
    this.jobs.delete(job);
    arrCall(this.countsListeners, this.log, this.counts);
    this.dispatch();
  }

  getCounts() {
    return {
      pending: this.counts[JobState.Pending],
      yielding: this.counts[JobState.Yielding],
      running: this.counts[JobState.Running],
      completed: this.counts[JobState.Completed],
      removed: this.counts[JobState.Removed],
    };
  }

  onCounts(cb: (counts: JobCounts) => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    cb(this.counts);
    this.countsListeners.add(cb);
    signal.addEventListener('abort', () => assert(this.countsListeners.delete(cb)));
  }

  [Symbol.dispose](): void {
    for (const controller of this.jobs.values()) {
      controller.cancel?.abort();
    }
  }

  private dispatch() {
    this.checkCounts();

    // const sortedJobs = [...this.jobs.entries()].sort((a, b) => b[0].priority() - a[0].priority());

    // TODO: Implement this correctly
    for (const [job, handle] of this.jobs.entries()) {
      if (handle.state === JobState.Pending) {
        this.launch(job, handle);
      }
    }
  }

  private launch(job: Job, handle: JobHandle) {
    this.updateState(handle, JobState.Pending, JobState.Running);

    assert(handle.cancel === undefined);
    handle.cancel = new AbortController();

    const flowCtl: FlowCtl = {
      signal: handle.userSignal !== undefined
        ? AbortSignal.any([handle.cancel.signal, handle.userSignal])
        : handle.cancel.signal,
      yield: () => {
        // TODO: Implement this
        // Either return immediately if this is still a high-priority job (in the top 4), or return a promise if another job should start and this one yield (if it's in the top 16=4+12), or throw a `CancelError` if the job should be cancelled.
      },
    };

    job.run(flowCtl).then((result) => {
      this.updateState(handle, JobState.Running, JobState.Completed);
      handle.onDone(result);
      this.dispatch();
    }, (error) => {
      // Not logged here: RunQueue has no context, and handle.onError delivers
      // the error to the caller, which logs it with the job's own scope.
      this.updateState(handle, JobState.Running, JobState.Completed);
      handle.onError(error);
      this.dispatch();
    });
  }

  private updateState(handle: JobHandle, oldState: JobState, newState: JobState): void {
    assert(handle.state === oldState);
    this.counts[handle.state]--;
    this.counts[newState]++;
    handle.state = newState;
    arrCall(this.countsListeners, this.log, this.counts);
  }

  private checkCounts() {
    assert(
      this.counts[JobState.Pending] + this.counts[JobState.Yielding] +
          this.counts[JobState.Running] + this.counts[JobState.Completed] === this.jobs.size,
    );
  }
}
