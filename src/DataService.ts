import { Context } from './Context.ts';
import { Fact } from './FactMeta.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { BlockBuilder } from './BlockBuilder.ts';
import { rootHash } from './constants.ts';
import { FactService } from './FactService.ts';
import { ClockService } from './ClockService.ts';
import { EMPTY_ARR } from './util/buffer.ts';
import * as hashes from './constants.ts';

export class DataService {
  private requesting = new Set<HashPrimitive>(
    Object.values(hashes).map((x) => x.toPrimitive()),
  );

  constructor(private ctx: Context) {}

  public request(hash: Hash) {
    if (!this.requesting.has(hash.toPrimitive())) {
      this.requesting.add(hash.toPrimitive());
      this.ctx.get(ClockService).setTimeout(() => {
        if (!this.ctx.get(FactService).has(hash)) {
          // TODO: Once we get the data, we don't need to keep publishing anymore
          this.ctx.get(BlockBuilder).publishPersistentDraft({
            outputs: [{
              verifier: { contractHash: rootHash, params: hash.toBytes() },
              amount: 0n,
              detail: EMPTY_ARR,
            }],
          });
        }
      }, 0);
    }
  }

  private getSignatories(hash: Hash): Fact[] {
    return [];
  }
}
