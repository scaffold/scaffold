import { Context } from '../Context.ts';
import { BlockFact } from '../FactMeta.ts';
import { ReactiveRecordSet } from '../util/ReactiveRecordSet.ts';
import { FactService } from '../FactService.ts';
import { FactType } from '../FactMeta.ts';

export class BlockRecordSet implements ReactiveRecordSet<BlockFact> {
  constructor(private ctx: Context) {}

  getAll(): Iterable<BlockFact> {
    return this.ctx.get(FactService).hackyGetBlocksMatching();
  }

  onAdd(cb: (record: BlockFact) => void): void {
    this.ctx.get(FactService).onIngest(FactType.Block, cb);
  }
  offAdd(cb: (record: BlockFact) => void): void {
    this.ctx.get(FactService).offIngest(FactType.Block, cb);
  }

  onRemove(cb: (record: BlockFact) => void): void {
    this.ctx.get(FactService).onForget(FactType.Block, cb);
  }
  offRemove(cb: (record: BlockFact) => void): void {
    this.ctx.get(FactService).offForget(FactType.Block, cb);
  }

  onUpdate(record: BlockFact, cb: (record: BlockFact) => void): void {
  }
  offUpdate(record: BlockFact, cb: (record: BlockFact) => void): void {
  }
}
