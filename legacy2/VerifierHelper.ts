import { Context } from './Context.ts';
import { Verifier } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { areTreesEqual } from './DataTreeHelper.ts';

export class VerifierHelper {
  constructor(private ctx: Context) {}

  public static equals(a: Verifier, b: Verifier) {
    return Hash.equals(a.contractHash, b.contractHash) && areTreesEqual(a.params, b.params);
  }
}
