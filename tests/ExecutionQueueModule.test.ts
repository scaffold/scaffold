import { assertEquals } from '@std/assert';
import {
  Executable,
  ExecutionQueueModule,
  TaskResult,
} from '../src/core/ExecutionQueueModule.ts';

// -- Test helpers ------------------------------------------------

/** A deferred promise that can be resolved/rejected externally. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Create a controllable executable with a deferred run(). */
function executable(
  opts: { priority?: number; maxCostMs?: number; onTimeout?: () => void } = {},
): { exec: Executable; d: Deferred<void>; setPriority: (p: number) => void } {
  let currentPriority = opts.priority ?? 10;
  const d = deferred<void>();
  const exec: Executable = {
    priority: () => currentPriority,
    maxCostMs: opts.maxCostMs ?? 1000,
    run: () => d.promise,
    onTimeout: opts.onTimeout,
  };
  return { exec, d, setPriority: (p: number) => currentPriority = p };
}

function setup(config?: { maxWorkers?: number; maxAcceptableCostMs?: number }) {
  return new ExecutionQueueModule(config);
}

// -- Enqueueing --------------------------------------------------

Deno.test('ExecutionQueue: enqueue returns task ID', () => {
  const queue = setup();
  const { exec } = executable();
  const id = queue.enqueue(exec);
  assertEquals(typeof id, 'string');
  assertEquals(queue.taskCount, 1);
  queue.dispose();
});

Deno.test('ExecutionQueue: rejects when maxCostMs exceeds maxAcceptableCostMs', () => {
  const queue = setup({ maxAcceptableCostMs: 500 });
  const { exec } = executable({ maxCostMs: 1000 });
  const id = queue.enqueue(exec);
  assertEquals(id, undefined);
  assertEquals(queue.taskCount, 0);
});

Deno.test('ExecutionQueue: accepts when maxCostMs equals maxAcceptableCostMs', () => {
  const queue = setup({ maxAcceptableCostMs: 500 });
  const { exec } = executable({ maxCostMs: 500 });
  const id = queue.enqueue(exec);
  assertEquals(typeof id, 'string');
  queue.dispose();
});

// -- Priority ordering -------------------------------------------

Deno.test('ExecutionQueue: dispatches highest priority first', async () => {
  const queue = setup({ maxWorkers: 1 });

  // Block the single worker slot
  const blocker = executable();
  queue.enqueue(blocker.exec);
  assertEquals(queue.runningCount, 1);

  // Enqueue low and high priority tasks
  const low = executable({ priority: 10 });
  const high = executable({ priority: 100 });
  queue.enqueue(low.exec);
  queue.enqueue(high.exec);

  // Free the worker -- high-priority should start
  blocker.d.resolve();
  await tick();

  // High is running (its deferred was consumed by run()), low is still queued
  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 1);
  queue.dispose();
});

Deno.test('ExecutionQueue: tasks of different priorities compete correctly', async () => {
  const queue = setup({ maxWorkers: 1 });

  const blocker = executable();
  queue.enqueue(blocker.exec);

  // Enqueue tasks: priority 50 then 100
  const first = executable({ priority: 50 });
  const second = executable({ priority: 100 });
  queue.enqueue(first.exec);
  queue.enqueue(second.exec);

  // Free the worker
  blocker.d.resolve();
  await tick();

  // Second (priority 100) should be running, first (50) queued
  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 1);

  // Complete the running task to verify first also runs
  second.d.resolve();
  await tick();

  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 0);
  queue.dispose();
});

// -- Concurrency limit -------------------------------------------

Deno.test('ExecutionQueue: respects maxWorkers limit', () => {
  const queue = setup({ maxWorkers: 2 });
  queue.enqueue(executable().exec);
  queue.enqueue(executable().exec);
  queue.enqueue(executable().exec);

  assertEquals(queue.runningCount, 2);
  assertEquals(queue.queueLength, 1);
  queue.dispose();
});

Deno.test('ExecutionQueue: dispatches next when worker frees', async () => {
  const queue = setup({ maxWorkers: 1 });
  const a = executable();
  const b = executable();
  queue.enqueue(a.exec);
  queue.enqueue(b.exec);

  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 1);

  a.d.resolve();
  await tick();

  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 0);
  queue.dispose();
});

// -- Timeout termination -----------------------------------------

Deno.test('ExecutionQueue: terminates on timeout and calls onTimeout', async () => {
  const queue = setup();
  let timedOut = false;
  const { exec } = executable({
    maxCostMs: 50,
    onTimeout: () => timedOut = true,
  });

  const results: TaskResult[] = [];
  queue.onComplete((_task, result) => results.push(result));

  queue.enqueue(exec);
  assertEquals(queue.runningCount, 1);

  await sleep(100);

  assertEquals(results.length, 1);
  assertEquals(results[0].outcome, 'terminated');
  assertEquals(timedOut, true);
  assertEquals(queue.runningCount, 0);
});

Deno.test('ExecutionQueue: successful completion before timeout clears timer', async () => {
  const queue = setup();
  const { exec, d } = executable({ maxCostMs: 200 });

  const results: TaskResult[] = [];
  queue.onComplete((_task, result) => results.push(result));

  queue.enqueue(exec);
  d.resolve();
  await tick();

  assertEquals(results.length, 1);
  assertEquals(results[0].outcome, 'success');

  // Wait past timeout -- no duplicate
  await sleep(250);
  assertEquals(results.length, 1);
});

Deno.test('ExecutionQueue: error in run() records failure', async () => {
  const queue = setup();
  const { exec, d } = executable();

  const results: TaskResult[] = [];
  queue.onComplete((_task, result) => results.push(result));

  queue.enqueue(exec);
  d.reject(new Error('crash'));
  await tick();

  assertEquals(results.length, 1);
  assertEquals(results[0].outcome, 'error');
});

// -- Cancel -------------------------------------------------------

Deno.test('ExecutionQueue: cancel queued task removes it', () => {
  const queue = setup({ maxWorkers: 1 });
  queue.enqueue(executable().exec);
  const id = queue.enqueue(executable().exec)!;
  assertEquals(queue.queueLength, 1);

  assertEquals(queue.cancel(id), true);
  assertEquals(queue.queueLength, 0);
  queue.dispose();
});

Deno.test('ExecutionQueue: cancel running task terminates it and dispatches next', () => {
  const queue = setup({ maxWorkers: 1 });
  const id = queue.enqueue(executable().exec)!;
  queue.enqueue(executable().exec);

  assertEquals(queue.runningCount, 1);

  assertEquals(queue.cancel(id), true);
  assertEquals(queue.runningCount, 1); // next task dispatched
  queue.dispose();
});

Deno.test('ExecutionQueue: cancel non-existent task returns false', () => {
  const queue = setup();
  assertEquals(queue.cancel('999'), false);
});

// -- Reprioritize ------------------------------------------------

Deno.test('ExecutionQueue: reprioritize reorders queued tasks', async () => {
  const queue = setup({ maxWorkers: 1 });

  const blocker = executable();
  queue.enqueue(blocker.exec);

  // Enqueue with initial priorities
  const a = executable({ priority: 100 });
  const b = executable({ priority: 50 });
  queue.enqueue(a.exec);
  queue.enqueue(b.exec);

  // Swap priorities
  a.setPriority(10);
  b.setPriority(200);
  queue.reprioritize();

  // Free the worker -- b should run first now
  blocker.d.resolve();
  await tick();

  // b is now running (we can verify by completing b and checking a runs next)
  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 1);

  b.d.resolve();
  await tick();

  // a should now be running
  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 0);
  queue.dispose();
});

// -- Task state ---------------------------------------------------

Deno.test('ExecutionQueue: getTask returns task details', () => {
  const queue = setup();
  const { exec } = executable();
  const id = queue.enqueue(exec)!;
  const task = queue.getTask(id);
  assertEquals(task?.status, 'running');
  assertEquals(task?.executable, exec);
  queue.dispose();
});

Deno.test('ExecutionQueue: onComplete fires with correct result', async () => {
  const queue = setup();
  const { exec, d } = executable();
  const fired: { status: string; outcome: string }[] = [];
  queue.onComplete((task, result) => {
    fired.push({ status: task.status, outcome: result.outcome });
  });

  queue.enqueue(exec);
  d.resolve();
  await tick();

  assertEquals(fired.length, 1);
  assertEquals(fired[0].status, 'completed');
  assertEquals(fired[0].outcome, 'success');
});

// -- Edge cases ---------------------------------------------------

Deno.test('ExecutionQueue: timeout after cancel does not fire callbacks', async () => {
  const queue = setup();
  let timedOut = false;
  const { exec } = executable({
    maxCostMs: 50,
    onTimeout: () => timedOut = true,
  });

  const results: TaskResult[] = [];
  queue.onComplete((_task, result) => results.push(result));

  const id = queue.enqueue(exec)!;
  queue.cancel(id);

  await sleep(100);

  assertEquals(results.length, 0);
  assertEquals(timedOut, false);
});

Deno.test('ExecutionQueue: completion after cancel is ignored', async () => {
  const queue = setup();
  const { exec, d } = executable();

  const results: TaskResult[] = [];
  queue.onComplete((_task, result) => results.push(result));

  const id = queue.enqueue(exec)!;
  queue.cancel(id);

  d.resolve();
  await tick();

  assertEquals(results.length, 0);
});

Deno.test('ExecutionQueue: timeout dispatches next task', async () => {
  const queue = setup({ maxWorkers: 1 });

  const fast = executable({ maxCostMs: 50 });
  const slow = executable({ maxCostMs: 5000 });
  queue.enqueue(fast.exec);
  queue.enqueue(slow.exec);

  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 1);

  // Wait for first to timeout
  await sleep(100);

  // Second task should now be running
  assertEquals(queue.runningCount, 1);
  assertEquals(queue.queueLength, 0);
  queue.dispose();
});

Deno.test('ExecutionQueue: onTimeout is optional', async () => {
  const queue = setup();
  // No onTimeout callback
  const exec: Executable = {
    priority: () => 10,
    maxCostMs: 50,
    run: () => new Promise(() => {}), // never resolves
  };

  queue.enqueue(exec);
  await sleep(100);

  assertEquals(queue.runningCount, 0);
});

// -- Helpers ------------------------------------------------------

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
