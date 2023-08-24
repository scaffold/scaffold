import Hash, { HashPrimitive } from './util/Hash.ts';
import Context from './Context.ts';
import { trueHash } from './constants.ts';
import { Verifier } from '~/sbl/messages.ts';

export default class FreeMarketService {
  private freeMarketContractHashes = new Set<HashPrimitive>();

  constructor(private ctx: Context) {
    [
      trueHash,
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0000000000000000000000000000000000000000000000000000000000000001',
      '0000000000000000000000000000000000000000000000000000000000000002',
      '0000000000000000000000000000000000000000000000000000000000000003',
    ].map((hash) =>
      this.addHash(hash instanceof Hash ? hash : Hash.fromHex(hash))
    );
  }

  private addHash(contractHash: Hash) {
    this.freeMarketContractHashes.add(contractHash.toPrimitive());
  }

  public isFreeMarket({ contract_hash }: Verifier) {
    return this.freeMarketContractHashes.has(contract_hash.toPrimitive());
  }
}
