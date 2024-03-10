import { BlockService } from '../BlockService.ts';
import { Context } from '../Context.ts';
import { FactBase } from '../FactMeta.ts';
import { BlockFact, FactType, SignedFact } from '../FactMeta.ts';
import { FactService } from '../FactService.ts';
import { IngestionProvider } from '../IngestionProvider.ts';
import { UnspentOutputManager } from '../UnspentOutputManager.ts';
import { BlockRecordSet } from '../record_sets/BlockRecordSet.ts';

export class BlockIngestor implements IngestionProvider<BlockFact> {
  type = FactType.Block as const;
  isPersistent = true;
  isSigned = true as const;

  constructor(private ctx: Context) {}

  create(base: FactBase) {
    return {} as BlockFact;
  }

  ingest(fact: BlockFact) {
    this.ctx.get(BlockService).updateCanonicalities(
      this.ctx.get(FactService).hackyGetBlocksMatching(),
    );

    this.ctx.maybeGet(BlockRecordSet)?.dispatchAdd(fact);

    this.ctx.get(UnspentOutputManager).tick();
  }

  forget(fact: BlockFact) {
    this.ctx.get(BlockService).forget(fact);
    this.ctx.maybeGet(BlockRecordSet)?.dispatchRemove(fact);
  }
}
