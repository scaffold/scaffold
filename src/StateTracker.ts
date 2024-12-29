import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { FetchService } from './FetchService.ts';
import { Block, Verifier } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { StateTracker as StateTrackerUtil } from './util/StateTracker.ts';

export class StateTracker extends StateTrackerUtil<Verifier, Uint8Array | undefined> {
  constructor(private ctx: Context) {
    super(
      (verifier, onBody) => this.ctx.get(FetchService).fetch(verifier, { onBody }),
      ctx.config.timeProvider,
    );
  }
}
