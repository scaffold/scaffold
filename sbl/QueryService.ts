import Context from './Context.ts';
import { Block, Verifier } from './messages.ts';
import { BlocksByVerifierStore } from './stores.ts';
import Hash from './util/Hash.ts';
import StoreObserver from './util/StoreObserver.ts';

export default class QueryService {
  constructor(private ctx: Context) {}

  // Doesn't incentivize or send bids
  public query(verifier: Verifier, cb: (block: Block) => void) {
    let prevBlock: Block | undefined;
    StoreObserver.get(this.ctx.get(BlocksByVerifierStore)).observe(
      Hash.digest(Verifier.encode(verifier)),
      (blocks) => {
        // TODO: Find canonical block
        // Rank by mergability probability
        //   Which is mostly the amount allocated to free-market verifiers from all terminal descendants
        if (blocks && blocks[0] !== prevBlock) {
          prevBlock = blocks[0];
          cb(prevBlock);
        }
      },
    );
  }
}
