import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import FetchService from './FetchService.ts';
import IncentiveService from './IncentiveService.ts';
import { Block, Verifier } from './messages.ts';
import Hash from './util/Hash.ts';
import StateTrackerUtil from './util/StateTracker.ts';
import StoreObserver from './util/StoreObserver.ts';

export default class StateTracker
  extends StateTrackerUtil<Verifier, BlockFact> {
  constructor(private ctx: Context) {
    super(
      (verifier: Verifier, onState: (state: BlockFact) => void) =>
        this.ctx.get(FetchService).fetch(
          verifier,
          { internalIncentive: 10n },
          onState,
        )!,
      ctx.config.timeProvider,
    );
  }
}
