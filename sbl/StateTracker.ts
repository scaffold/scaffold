import Context from './Context.ts';
import IncentiveService from './IncentiveService.ts';
import { Block, Verifier } from './messages.ts';
import { BlocksByVerifierStore } from './stores.ts';
import Hash from './util/Hash.ts';
import StateTrackerUtil from './util/StateTracker.ts';
import StoreObserver from './util/StoreObserver.ts';

export default class StateTracker
  extends StateTrackerUtil<Verifier, Block[] | undefined> {
  constructor(private ctx: Context) {
    super(
      (verifier: Verifier, onState: (state: Block[] | undefined) => void) => {
        this.ctx.get(IncentiveService).incentivize(verifier, 10n);

        StoreObserver.get(this.ctx.get(BlocksByVerifierStore)).observe(
          Hash.digest(Verifier.encode(verifier)),
          onState,
        );

        return {
          release: () => {
            StoreObserver.get(this.ctx.get(BlocksByVerifierStore)).unobserve(
              Hash.digest(Verifier.encode(verifier)),
              onState,
            );
          },
        };
      },
    );
  }
}
