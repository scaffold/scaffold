import { Context } from '../Context.ts';
import { RunQueue, RunQueueConfig } from '../util/RunQueue.ts';

export { CancelError, type FlowCtl, type Job, type JobCounts, JobState } from '../util/RunQueue.ts';

export class ExecutionQueueConfig implements RunQueueConfig {
  maxRunning = 4;
  maxYielding = 12;
}

export class ExecutionQueue extends RunQueue {
  constructor(ctx: Context) {
    super(ctx.get(ExecutionQueueConfig), ctx.logger('execution_queue'));
  }
}
