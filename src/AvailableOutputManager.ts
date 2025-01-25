import { InputSpec } from './BlockBuilder.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { FactService } from './FactService.ts';
import { Verifier } from './messages.ts';
import { AvailableOutputRecordSet } from './record_sets/AvailableOutputRecordSet.ts';
import { Hash } from './util/Hash.ts';
import { QueueMuxer } from './util/QueueMuxer.ts';
import { WeightService } from './WeightService.ts';

// TODO: Rename to AvailableOutputManager to reflect including outputs claimed by uncanonical blocks
export class AvailableOutputManager extends QueueMuxer<Verifier, InputSpec> {
  constructor(private ctx: Context) {
    super((verifier) => Hash.digest(Verifier.encode(verifier)).toPrimitive());

    const itvl = ctx.config.timeProvider.setInterval(
      () => this.tick(),
      1000, // TODO: Make this configurable and disablable
    );
    ctx.onDestruct(() => ctx.config.timeProvider.clearInterval(itvl));
  }

  // TODO: Remove this hacky method and add/remove outputs to the manager
  public override popAll(key: Verifier, filter: (value: InputSpec) => boolean) {
    return this.ctx.get(FactService).hackyGetBlocksMatching().flatMap((block) =>
      block.outputs
        .map((x, outputIdx) => ({ block, outputIdx, verifier: x.verifier, amount: x.amount }))
        .filter((x) =>
          this.ctx.get(BlockService).areVerifiersEqual(key, x.verifier) &&
          !block.claims.get(x.outputIdx)?.some((claim) =>
            this.ctx.get(WeightService).isCanonical(claim)
          ) && filter(x)
        )
    );
  }

  public override pop(key: Verifier, filter: (value: InputSpec) => boolean) {
    return this.popAll(key, filter)[0];
  }

  public tick() {
    for (const queue of this.getQueues().values()) {
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

  protected override getRecordSet() {
    return this.ctx.maybeGet(AvailableOutputRecordSet);
  }
}
