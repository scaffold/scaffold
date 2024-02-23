import { InputSpec } from './BlockBuilder.ts';
import { Context } from './Context.ts';
import { Verifier } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { Queue } from './util/Queue.ts';

export class UnspentOutputManager extends Queue<Verifier, InputSpec> {
  constructor(private ctx: Context) {
    super((verifier) => Hash.digest(Verifier.encode(verifier)).toPrimitive());

    const itvl = ctx.config.timeProvider.setInterval(
      () => this.tick(),
      1000, // TODO: Make this configurable and disablable
    );
    ctx.onDestruct(() => ctx.config.timeProvider.clearInterval(itvl));
  }

  public tick() {
    for (const queue of this.queues.values()) {
      for (let i = 0; i < queue.pending.length; i++) {
        for (let j = 0; j < queue.handlers.length; j++) {
          if (queue.handlers[j].filter(queue.pending[i])) {
            queue.handlers.splice(j, 1)[0].resolve(
              queue.pending.splice(i--, 1)[0],
            );
            break;
          }
        }
      }
    }

    this.cleanup();
  }
}
