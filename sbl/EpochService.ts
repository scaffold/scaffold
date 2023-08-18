import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import StateTracker from './StateTracker.ts';
import { epochHash } from '~/sbl/constants.ts';
import { EpochParams } from '~/sbl/messages.ts';

export default class EpochService {
  private tracker: StateTracker;
  private canonicalEpochMap = new Map<bigint, BlockFact>();
  private canonicalEpochSet = new Set<BlockFact>();

  constructor(private ctx: Context) {
    this.tracker = new StateTracker(ctx);
    // this.tracker.track(
    //   (height) => ({
    //     contract_hash: epochHash,
    //     params: EpochParams.encode({ height }),
    //   }),
    //   (idx, state) => {
    //     console.log('EpochService', idx, state);

    //     const prevEpoch = this.canonicalEpochMap.get(idx);
    //     this.canonicalEpochMap.set(idx, state);

    //     if (prevEpoch) {
    //       this.canonicalEpochSet.delete(prevEpoch);
    //     }
    //     this.canonicalEpochSet.add(state);
    //   },
    // );
  }

  public isCanonical(block: BlockFact) {
    return block.isEpoch && this.canonicalEpochSet.has(block);
  }
}
