import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { Block, BlockInput, Verifier } from './messages.ts';
import { trueHash } from './constants.ts';

export default class FreeMarketService {
  constructor(private ctx: Context) {}

  public isFreeMarket(verifier: Verifier) {
    if (Hash.equals(verifier.contract_hash, trueHash)) {
      return true;
    } else {
      return false;
    }
  }
}
