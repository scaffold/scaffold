import { Context } from './Context.ts';
import { Verifier } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { arrEquals } from './util/buffer.ts';
import { QaDebugger } from './QaDebugger.ts';
import { bin2hex } from './util/hex.ts';

export class VerifierHelper {
  constructor(private ctx: Context) {}

  public static equals(a: Verifier, b: Verifier) {
    return (
      Hash.equals(a.contractHash, b.contractHash) &&
      arrEquals(a.params, b.params)
    );
  }
}
