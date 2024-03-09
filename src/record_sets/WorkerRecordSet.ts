import { Context } from '../Context.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { WorkerDriver, WorkerDriverService } from '../WorkerDriverService.ts';

export class WorkerRecordSet extends ReactiveRecordSet<WorkerDriver> {
  constructor(private ctx: Context) {
    super();
  }

  public getAll(): Iterable<WorkerDriver> {
    return this.ctx.get(WorkerDriverService).getAllWorkers();
  }
}
