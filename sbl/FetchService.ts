import BlockBuilder from './BlockBuilder.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import Context from './Context.ts';
import ExecutorLauncherService from './ExecutorLauncherService.ts';
import IncentiveService from './IncentiveService.ts';
import LocalGeneratorService from './LocalGeneratorService.ts';
import { Block, Verifier } from './messages.ts';
import NodeService from './NodeService.ts';
import { bin2hex } from './pathUtils.ts';
import QaDebugger from './QaDebugger.ts';
import { error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import { trunc } from './util/string.ts';

export const enum FetchMode {
  All,
  Canonical,
}

interface FetchOptions {
  dedupKey?: Hash | unknown;
  internalIncentive?: bigint;
  externalIncentive?: bigint; // TODO: Remove this, since we calculate it via config. Maybe change to boolean, if there's cases when we don't want to incentivize.
  bid?: { output: Verifier; amount: bigint };
  blockSelector?: (blocks: BlockExt[]) => BlockExt;
  blockComparator?: (a: BlockExt, b: BlockExt) => number;
  verify?: true;
  certaintyThreshold?: number;
}

// TODO: Find canonical block
// Rank by mergability probability
//   Which is mostly the amount allocated to free-market verifiers from all terminal descendants
export const defaultBlockSelector = (blocks: BlockExt[]) => blocks[0];
export const defaultBlockComparator = (a: BlockExt, b: BlockExt) => -1;

// TODO: Rename to RequestService?
export default class FetchService {
  private pendingKeyedFetches = new Set<unknown>();

  constructor(private ctx: Context) {}

  // public listen(verifier:Verifier, {}?:FetchOptions, cb?: (body: Uint8Array) => void) {}
  // public listenBlock(verifier:Verifier, {}?:FetchOptions, cb?: (block: BlockExt) => void) {}
  // public fetch(verifier:Verifier, {}?:FetchOptions): Promise<Uint8Array> {}

  // TODO: Rename to query?
  public fetch(
    verifier: Verifier,
    {
      dedupKey,
      internalIncentive,
      externalIncentive,
      bid,
      blockSelector,
      blockComparator,
      verify,
    }: FetchOptions,
    cb?: (block: BlockExt) => void,
  ) {
    console.log(
      `Fetching block`,
      { ...verifier, ...this.ctx.get(QaDebugger).debugQuestion(verifier) },
    );

    internalIncentive = 1n;
    if (internalIncentive !== undefined) {
      this.ctx.get(ExecutorLauncherService).enqueueGeneration(
        verifier,
        Number(internalIncentive),
      );

      // TODO: We don't need the contract/generator before starting execution. Just request it like any other input.

      // const gen = this.ctx.get(LocalGeneratorService).getGenerator(
      //   verifier.contract_hash,
      // );
      // if (gen) {
      //   const res = gen({
      //     ctx: this.ctx,
      //     contractHash: verifier.contract_hash,
      //     params: verifier.params,
      //     emitCorrect: true,
      //     setFreeMarket: () => error('Not implemented'),
      //     request: (contractHash: Hash, params: Uint8Array) =>
      //       new Promise((resolve) =>
      //         this.fetch(
      //           { contract_hash: contractHash, params },
      //           {},
      //           // TODO: Handle dirty inputs (repeated resolve calls)
      //           (block) => resolve(block.body),
      //         )
      //       ),
      //     notify: (contractHash: Hash, params: Uint8Array) =>
      //       this.fetch({ contract_hash: contractHash, params }, {}),
      //   });
      //   if (res instanceof Promise) {
      //     res.then((body) => {
      //       const block = this.ctx.get(BlockBuilder).build(verifier, body);
      //       this.ctx.get(BlockService).ingest(block);
      //     });
      //   }
      // }

      // const verifierHash = Hash.digest(Verifier.encode(verifier));
      // this.ctx.get(ExtraIncentiveByVerifierStore).mutate(
      //   verifierHash,
      //   (val) => ({
      //     verifier,
      //     amount: val ? val.amount + internalIncentive : internalIncentive,
      //   }),
      // );
    }

    externalIncentive = this.ctx.config.getDepositIncentive(verifier);
    if (externalIncentive !== undefined) {
      this.ctx.get(IncentiveService).incentivize(verifier, externalIncentive);
    }

    // if (bid !== undefined) {
    //   this.ctx.get(NodeService).getAll().forEach((node) =>
    //     node.defaultConn?.sendReliable({
    //       BidMessage: {
    //         input: verifier,
    //         output: bid.output,
    //         amount: bid.amount,
    //       },
    //     })
    //   );
    // }

    let onState: (block: BlockExt) => void;
    if (cb !== undefined) {
      let prevBlock: BlockExt | undefined;
      onState = (block: BlockExt) => {
        if (
          prevBlock === undefined ||
          (blockComparator || defaultBlockComparator)(prevBlock, block)
        ) {
          prevBlock = block;
          cb(block);
        }
      };

      this.ctx.get(BlockService).onNewBlock(verifier, onState);
    }

    let released = false;
    return {
      release: () => {
        if (released) {
          throw new Error(`Cannot release multiple times`);
        }
        released = true;

        if (internalIncentive !== undefined) {
          this.ctx.get(ExecutorLauncherService).enqueueGeneration(verifier, 0);
        }

        if (externalIncentive !== undefined) {
          this.ctx.get(IncentiveService).incentivize(
            verifier,
            -externalIncentive,
          );
        }

        if (cb !== undefined) {
          this.ctx.get(BlockService).offNewBlock(verifier, onState);
        }
      },
      // getTotalInternalIncentive: () =>
      //   BigInt(this.ctx.get(WorkQueue).getTotalIncentive(verifier)),
      // getTotalExternalIncentive: () => error('Not implemented'),
      // setInternalIncentive: (incentive: bigint) => {
      //   this.ctx.get(WorkQueue).addExtraIncentive(
      //     verifier,
      //     Number(incentive - (internalIncentive || 0n)),
      //   );
      //   internalIncentive = incentive;
      // },
      // setExternalIncentive: (incentive: bigint) => {
      //   this.ctx.get(IncentiveService).incentivize(
      //     verifier,
      //     incentive - (externalIncentive || 0n),
      //   );
      //   externalIncentive = incentive;
      // },
    };
  }
}
