import Context from './Context.ts';
import StateTracker from './StateTracker.ts';
import { epochHash } from '~/sbl/constants.ts';
import { EpochParams } from '~/sbl/messages.ts';

export default class EpochService {
  private tracker: StateTracker;

  constructor(private ctx: Context) {
    this.tracker = new StateTracker(ctx);
    this.tracker.track(
      (height) => ({
        contract_hash: epochHash,
        params: EpochParams.encode({ height }),
      }),
      (idx, state) => {
        console.log('EpochService', idx, state);
      },
    );
  }
}
