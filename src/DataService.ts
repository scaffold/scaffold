import { Context } from './Context.ts';
import { Fact } from './FactMeta.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { BlockBuilder } from './BlockBuilder.ts';
import { rootHash } from './hashes.ts';
import { FactService } from './FactService.ts';
import { ClockService } from './ClockService.ts';
import { arrEquals, EMPTY_ARR } from './util/buffer.ts';
import * as hashes from './hashes.ts';
import { mapPut } from './util/map.ts';
import { EMPTY_DATA_TREE, encodeDataTree } from './DataTreeHelper.ts';

export class DataService {
  private registry = new Map<HashPrimitive, Uint8Array>();
  private requesting = new Set<HashPrimitive>(
    Object.values(hashes).map((x) => x.toPrimitive()),
  );

  constructor(private ctx: Context) {}

  addData(data: Uint8Array) {
    const hash = Hash.digest(data);
    mapPut(this.registry, hash.toPrimitive(), () => data, (prevData) => {
      if (!arrEquals(prevData, data)) {
        throw new Error(`Internal error!`);
      }
      return prevData;
    });
    return hash;
  }

  getData(hash: Hash) {
    return this.registry.get(hash.toPrimitive());
  }

  request(hash: Hash) {
    if (!this.requesting.has(hash.toPrimitive())) {
      this.requesting.add(hash.toPrimitive());
      this.ctx.get(ClockService).setTimeout(() => {
        if (!this.ctx.get(FactService).has(hash)) {
          // TODO: Once we get the data, we don't need to keep publishing anymore
          this.ctx.get(BlockBuilder).publishPersistentDraft({
            outputs: [{
              verifier: { contractHash: rootHash, params: encodeDataTree(hash) },
              amount: 0n,
              detail: EMPTY_DATA_TREE,
            }],
          });
        }
      }, 0);
    }
  }
}
