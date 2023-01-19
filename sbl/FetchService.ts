import Context from './Context.ts';
import IncentiveService from './IncentiveService.ts';
import { Block, Verifier } from './messages.ts';
import NodeService from './NodeService.ts';
import { bin2hex } from './pathUtils.ts';
import {
  BlocksByVerifierStore,
  ExtraIncentiveByVerifierStore,
} from './stores.ts';
import Hash from './util/Hash.ts';
import StoreObserver from './util/StoreObserver.ts';
import { trunc } from './util/string.ts';

interface FetchOptions {
  internalIncentive?: bigint;
  externalIncentive?: bigint;
  bid?: { output: Verifier; amount: bigint };
  blockSelector?: (blocks: Block[]) => Block;
  verify?: true;
}

// TODO: Find canonical block
// Rank by mergability probability
//   Which is mostly the amount allocated to free-market verifiers from all terminal descendants
export const defaultBlockSelector = (blocks: Block[]) => blocks[0];

export default class FetchService {
  constructor(private ctx: Context) {}

  public fetch(
    verifier: Verifier,
    { internalIncentive, externalIncentive, bid, blockSelector, verify }:
      FetchOptions,
    cb?: (block: Block) => void,
  ) {
    console.log(
      `Fetching block ${verifier.contract_hash.toHex()} : ${
        trunc(bin2hex(verifier.params), 100)
      }`,
    );

    if (internalIncentive !== undefined) {
      // TODO: We don't need the contract/generator before starting execution. Just request it like any other input.

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

    if (cb !== undefined) {
      let prevBlock: Block | undefined;
      StoreObserver.get(this.ctx.get(BlocksByVerifierStore)).observe(
        Hash.digest(Verifier.encode(verifier)),
        (blocks) => {
          if (blocks && blocks.length) {
            const newBlock = (blockSelector || defaultBlockSelector)(blocks);
            if (newBlock !== prevBlock) {
              prevBlock = newBlock;
              cb(prevBlock);
            }
          }
        },
      );
    }
  }
}
