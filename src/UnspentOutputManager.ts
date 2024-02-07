import { InputSpec } from './BlockBuilder.ts';
import { Context } from './Context.ts';
import { Verifier } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { Queue } from './util/Queue.ts';

export class UnspentOutputManager extends Queue<Verifier, InputSpec> {
  constructor(private ctx: Context) {
    super((verifier) => Hash.digest(Verifier.encode(verifier)).toPrimitive());

    const itvl = ctx.config.timeProvider.setInterval(
      () => this.cleanup(),
      1000, // TODO: Make this configurable and disablable
    );
    ctx.onDestruct(() => ctx.config.timeProvider.clearInterval(itvl));
  }
}
