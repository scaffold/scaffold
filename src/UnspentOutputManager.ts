import { InputSpec } from './BlockBuilder.ts';
import { Context } from './Context.ts';
import { Verifier } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { ResolvingMonitor } from './util/Monitor.ts';

export class UnspentOutputManager
  extends ResolvingMonitor<Verifier, InputSpec> {
  constructor(private ctx: Context) {
    super((verifier) => Hash.digest(Verifier.encode(verifier)).toPrimitive());
  }
}
