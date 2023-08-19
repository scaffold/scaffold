import Context from '~/sbl/Context.ts';
import { Fact } from '~/sbl/FactMeta.ts';
import Hash from '~/sbl/util/Hash.ts';

export default class HashRequestService {
  constructor(private ctx: Context) {}

  public requestHash(hash: Hash, signedFact: Fact) {
  }
}
