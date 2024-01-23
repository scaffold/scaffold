import Context from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import FetchService from './FetchService.ts';
import { Block, Verifier } from './messages.ts';
import Hash from './util/Hash.ts';
import StateTrackerUtil from './util/StateTracker.ts';

export default class StateTracker
  extends StateTrackerUtil<Verifier, Uint8Array> {
  constructor(private ctx: Context) {
    super(
      (verifier: Verifier, onState: (state: Uint8Array) => void) =>
        this.ctx.get(FetchService).fetch(
          verifier,
          { internalIncentive: 10n },
          onState,
        )!,
      ctx.config.timeProvider,
    );
  }
}
