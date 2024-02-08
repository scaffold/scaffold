import { Context } from '../Context.ts';
import { ReactiveRecordSet } from '../util/ReactiveRecordSet.ts';
import { WorkerDriver, WorkerDriverService } from '../WorkerDriverService.ts';

export class WorkerRecordSet extends ReactiveRecordSet<WorkerDriver> {
  constructor(private ctx: Context) {
    super();
  }

  getAll(): Iterable<WorkerDriver> {
    return this.ctx.get(WorkerDriverService).getAllWorkers();
  }
}
