import { Context } from './Context.ts';
import { FetchService } from './FetchService.ts';
import { Block, Verifier } from './messages.ts';
import { DataTree } from './protocol/base.ts';
import { StateTracker as StateTrackerUtil } from './util/StateTracker.ts';

export class StateTracker extends StateTrackerUtil<Verifier, DataTree | undefined> {
  constructor(private ctx: Context) {
    super(
      (verifier, onBody) => this.ctx.get(FetchService).fetch(verifier, { onBody }),
      ctx.config.timeProvider,
    );
  }
}
