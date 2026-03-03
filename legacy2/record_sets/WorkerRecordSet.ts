import { Context } from '../Context.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { Runner, WorkerManager } from '../WorkerManager.ts';
import { WorkerDriver } from '../WorkerDriver.ts';
import { unimplemented } from '@std/assert/unimplemented';

export class WorkerRecordSet extends ReactiveRecordSet<WorkerDriver> {
  constructor(ctx: Context) {
    super(ctx);
  }

  public getAll(): Iterable<WorkerDriver> {
    unimplemented();
  }
}
