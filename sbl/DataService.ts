import Context from '~/sbl/Context.ts';
import { Fact } from '~/sbl/FactMeta.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { rootHash } from '~/sbl/constants.ts';
import BlockService from '~/sbl/BlockService.ts';

export default class DataService {
  private requesting = new Set<HashPrimitive>();

  constructor(private ctx: Context) {}

  public request(hash: Hash) {
    // Note this doesn't check FactService

    this.ctx.get(BlockBuilder).publish({
      outputs: [{
        verifier: { contract_hash: rootHash, params: hash.toBytes() },
        amount: 1n,
        detail: new Uint8Array(),
      }],
    });
  }

  private getSignatories(hash: Hash): Fact[] {
    return [];
  }
}
