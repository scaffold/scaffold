import Hash, { HashPrimitive } from './util/Hash.ts';
import Context from './Context.ts';
import { trueHash } from './constants.ts';

export default class FreeMarketService {
  private freeMarketContractHashes = new Set<HashPrimitive>();

  constructor(private ctx: Context) {
    this.addHash(trueHash);

    [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0000000000000000000000000000000000000000000000000000000000000001',
      '0000000000000000000000000000000000000000000000000000000000000002',
      '0000000000000000000000000000000000000000000000000000000000000003',
    ].map((hex) => this.addHash(Hash.fromHex(hex)));
  }

  private addHash(contractHash: Hash) {
    this.freeMarketContractHashes.add(contractHash.toPrimitive());
  }

  public isFreeMarket(contractHash: Hash) {
    return this.freeMarketContractHashes.has(contractHash.toPrimitive());
  }
}
