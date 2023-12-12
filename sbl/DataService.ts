import Context from '~/sbl/Context.ts';
import { Fact } from '~/sbl/FactMeta.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { rootHash } from '~/sbl/constants.ts';
import FactService from '~/sbl/FactService.ts';
import ClockService from '~/sbl/ClockService.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';

export default class DataService {
  private requesting = new Set<HashPrimitive>();

  constructor(private ctx: Context) {}

  public request(hash: Hash) {
    if (!this.requesting.has(hash.toPrimitive())) {
      this.requesting.add(hash.toPrimitive());
      this.ctx.get(ClockService).setTimeout(() => {
        if (!this.ctx.get(FactService).has(hash)) {
          this.ctx.get(BlockBuilder).publish({
            outputs: [{
              verifier: { contract_hash: rootHash, params: hash.toBytes() },
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
