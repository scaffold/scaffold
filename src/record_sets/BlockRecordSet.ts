import { Context } from '../Context.ts';
import { BlockFact } from '../FactMeta.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { FactService } from '../FactService.ts';

export class BlockRecordSet extends ReactiveRecordSet<BlockFact> {
  constructor(private ctx: Context) {
    super();
  }

  public getAll(): Iterable<BlockFact> {
    return this.ctx.get(FactService).hackyGetBlocksMatching();
  }
}
