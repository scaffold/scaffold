// Protocol spec: docs/protocol/execution-queue.md

// -- Types ----------------------------------------------------------

/** The lifecycle states of a task. */
export type TaskStatus = 'queued' | 'running' | 'completed' | 'terminated' | 'failed';

/** Result of a completed task. */
export type TaskResult =
  | { outcome: 'success' }
  | { outcome: 'terminated' }
  | { outcome: 'error'; error: unknown };

/**
 * An executable task. The queue is agnostic to what it runs --
 * callers construct Executable objects with the right priority,
 * cost budget, and run function.
 */
export interface Executable {
  /** Current priority. Higher = runs first. May be re-evaluated by the queue. */
  priority(): number;
  /** Maximum wall-clock time in ms. If exceeded, run() is abandoned. */
  readonly maxCostMs: number;
  /** Execute the task. The queue races this against the timeout. */
  run(): Promise<void>;
  /** Called when the task is terminated due to timeout. Optional. */
  onTimeout?(): void;
}

/** A task in the queue with its executable and lifecycle state. */
export interface QueuedTask {
  readonly id: string;
  readonly executable: Executable;
  readonly enqueuedAt: number;
  status: TaskStatus;
}

// -- Configuration --------------------------------------------------

export interface ExecutionQueueConfig {
  /** Maximum number of concurrent workers. Default: 4. */
  maxWorkers?: number;
  /** Maximum wall-clock cost the node will accept (ms). Default: 30000. */
  maxAcceptableCostMs?: number;
}

const DEFAULT_CONFIG: Required<ExecutionQueueConfig> = {
  maxWorkers: 4,
  maxAcceptableCostMs: 30_000,
};

// -- Internal types -------------------------------------------------

/** A running task with its timeout handle. */
interface RunningTask {
  readonly taskId: string;
  readonly timeoutHandle: ReturnType<typeof setTimeout>;
  aborted: boolean;
}

// -- Module ---------------------------------------------------------

/**
 * A priority queue with a bounded worker pool and wall-clock timeouts.
 *
 * The queue is agnostic to what it runs. Callers enqueue Executable objects
 * that define their own priority, cost budget, and run function. The queue
 * dispatches in priority order, enforces wall-clock limits, and reports
 * results via onComplete listeners.
 */
export class ExecutionQueueModule {
  private readonly _config: Required<ExecutionQueueConfig>;

  /** All tasks, keyed by task ID. */
  private readonly _tasks = new Map<string, QueuedTask>();

  /** Pending task IDs in priority order (highest first). */
  private _queue: string[] = [];

  /** Currently running tasks. */
  private readonly _running = new Map<string, RunningTask>();

  /** Completion listeners. */
  private readonly _listeners: ((task: QueuedTask, result: TaskResult) => void)[] = [];

  /** Monotonic task ID counter. */
  private _nextId = 1;

  constructor(config?: ExecutionQueueConfig) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  // -- Enqueueing ---------------------------------------------------

  /**
   * Enqueue an executable task.
   * Returns the task ID, or undefined if rejected (cost exceeds maxAcceptableCostMs).
   */
  enqueue(executable: Executable): string | undefined {
    if (executable.maxCostMs > this._config.maxAcceptableCostMs) {
      return undefined;
    }

    const id = String(this._nextId++);
    const task: QueuedTask = {
      id,
      executable,
      enqueuedAt: Date.now(),
      status: 'queued',
    };

    this._tasks.set(id, task);
    this._queue.push(id);
    this._sortQueue();
    this._dispatch();
    return id;
  }

  // -- Lifecycle ----------------------------------------------------

  /** Cancel a task (removes from queue or terminates if running). */
  cancel(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'queued') {
      this._queue = this._queue.filter((id) => id !== taskId);
      this._tasks.delete(taskId);
      return true;
    }

    if (task.status === 'running') {
      const running = this._running.get(taskId);
      if (running) {
        running.aborted = true;
        clearTimeout(running.timeoutHandle);
        this._running.delete(taskId);
      }
      this._tasks.delete(taskId);
      this._dispatch();
      return true;
    }

    return false;
  }

  /** Re-evaluate all queued task priorities and re-sort. */
  reprioritize(): void {
    this._sortQueue();
  }

  /** Clear all timers and running state. Call when shutting down. */
  dispose(): void {
    for (const running of this._running.values()) {
      running.aborted = true;
      clearTimeout(running.timeoutHandle);
    }
    this._running.clear();
    this._queue.length = 0;
    this._tasks.clear();
  }

  /**
   * ProtocolContext's BaseContext picks up Symbol.dispose on registered
   * services. Wired here so `ctx.destruct()` (and `Scaffold.close()`)
   * clears any in-flight task timeouts.
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  // -- Queries ------------------------------------------------------

  /** Number of tasks in the queue (pending only). */
  get queueLength(): number {
    return this._queue.length;
  }

  /** Number of currently running tasks. */
  get runningCount(): number {
    return this._running.size;
  }

  /** Total tasks (queued + running). */
  get taskCount(): number {
    return this._queue.length + this._running.size;
  }

  /** Get a task by ID. */
  getTask(taskId: string): QueuedTask | undefined {
    return this._tasks.get(taskId);
  }

  // -- Listeners ----------------------------------------------------

  /** Register a listener for task completion/termination. */
  onComplete(cb: (task: QueuedTask, result: TaskResult) => void): void {
    this._listeners.push(cb);
  }

  // -- Internal -----------------------------------------------------

  private _sortQueue(): void {
    this._queue.sort((a, b) => {
      const ta = this._tasks.get(a)!;
      const tb = this._tasks.get(b)!;
      return tb.executable.priority() - ta.executable.priority();
    });
  }

  /** Dispatch pending tasks while workers are available. */
  private _dispatch(): void {
    while (this._running.size < this._config.maxWorkers && this._queue.length > 0) {
      const taskId = this._queue.shift()!;
      const task = this._tasks.get(taskId);
      if (!task || task.status !== 'queued') continue;
      this._startTask(task);
    }
  }

  /** Start executing a task with wall-clock timeout. */
  private _startTask(task: QueuedTask): void {
    task.status = 'running';

    const running: RunningTask = {
      taskId: task.id,
      timeoutHandle: setTimeout(() => {
        this._onTimeout(task.id);
      }, task.executable.maxCostMs),
      aborted: false,
    };

    this._running.set(task.id, running);

    task.executable.run().then(
      () => {
        if (running.aborted) return;
        clearTimeout(running.timeoutHandle);
        this._onFinished(task.id, { outcome: 'success' });
      },
      (error) => {
        if (running.aborted) return;
        clearTimeout(running.timeoutHandle);
        this._onFinished(task.id, { outcome: 'error', error });
      },
    );
  }

  /** Handle timeout: terminate and notify. */
  private _onTimeout(taskId: string): void {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    const running = this._running.get(taskId);
    if (running) {
      running.aborted = true;
      this._running.delete(taskId);
    }

    this._onFinished(taskId, { outcome: 'terminated' });

    task.executable.onTimeout?.();
  }

  /** Common completion handler: update state, notify listeners, dispatch next. */
  private _onFinished(taskId: string, result: TaskResult): void {
    const task = this._tasks.get(taskId);
    if (!task) return;

    task.status = result.outcome === 'success'
      ? 'completed'
      : result.outcome === 'terminated'
      ? 'terminated'
      : 'failed';

    this._running.delete(taskId);

    for (const cb of this._listeners) cb(task, result);

    this._dispatch();
  }
}
