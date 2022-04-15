import Context from './Context.ts';
import WorkQueueUtil from './util/WorkQueue.ts';

export default class WorkQueue extends WorkQueueUtil {
  constructor(private ctx: Context) {
    super();

    ctx.onDestruct(() => this.setWorkerCount(0));

    const idx = setInterval(() => this.cleanup(), 1000);
    ctx.onDestruct(() => clearInterval(idx));

    this.setWorkerCount(ctx.config.initialWorkerCount);
  }
}
