import { Context } from '../Context.ts';
import { Fact, FactRef } from '../FactMeta.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { FactService } from '../FactService.ts';

export class FactRecordSet extends ReactiveRecordSet<Fact | FactRef> {
  constructor(ctx: Context) {
    super(ctx);
  }

  public getAll(): (Fact | FactRef)[] {
    return this.ctx.get(FactService).getAll();
  }
}
