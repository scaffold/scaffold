import Context from './Context.ts';
import IncentiveService from './IncentiveService.ts';
import { Block, Verifier } from './messages.ts';
import NodeService from './NodeService.ts';
import {
  BlocksByVerifierStore,
  ExtraIncentiveByVerifierStore,
} from './stores.ts';
import Hash from './util/Hash.ts';
import StoreObserver from './util/StoreObserver.ts';

interface FetchOptions {
  internalIncentive?: bigint;
  externalIncentive?: bigint;
  bid?: { output: Verifier; amount: bigint };
}

export default class FetchService {
  constructor(private ctx: Context) {}

  public fetch(
    verifier: Verifier,
    { internalIncentive, externalIncentive, bid }: FetchOptions,
    cb: (block: Block) => void,
  ) {
    if (internalIncentive !== undefined) {
      const verifierHash = Hash.digest(Verifier.encode(verifier));
      this.ctx.get(ExtraIncentiveByVerifierStore).mutate(
        verifierHash,
        (val) => ({
          verifier,
          amount: val ? val.amount + internalIncentive : internalIncentive,
        }),
      );
    }

    if (externalIncentive !== undefined) {
      this.ctx.get(IncentiveService).incentivize(verifier, externalIncentive);
    }

    if (bid !== undefined) {
      this.ctx.get(NodeService).getAll().forEach((node) =>
        node.defaultConn?.sendReliable({
          BidMessage: {
            input: verifier,
            output: bid.output,
            amount: bid.amount,
          },
        })
      );
    }

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
