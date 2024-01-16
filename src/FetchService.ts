import BlockService from './BlockService.ts';
import Context from './Context.ts';
import GenerationService from './GenerationService.ts';
import { BlockFact } from './FactMeta.ts';
import { Block, Verifier } from './messages.ts';
import Hash from './util/Hash.ts';
import BlockBuilder from './BlockBuilder.ts';
import { EMPTY_ARR } from './util/buffer.ts';

export const enum FetchMode {
  All,
  Canonical,
}

interface FetchOptions {
  detail?: Uint8Array;
  dedupKey?: Hash | unknown;
  internalIncentive?: bigint;
  externalIncentive?: bigint; // TODO: Remove this, since we calculate it via config. Maybe change to boolean, if there's cases when we don't want to incentivize.
  bid?: { output: Verifier; amount: bigint };
  blockSelector?: (blocks: BlockFact[]) => BlockFact;
  blockComparator?: (a: BlockFact, b: BlockFact) => number;
  verify?: true;
  certaintyThreshold?: number;
  abortSignal?: AbortSignal;
}

// TODO: Find canonical block
// Rank by mergability probability
//   Which is mostly the amount allocated to free-market verifiers from all terminal descendants
export const defaultBlockSelector = (blocks: BlockFact[]) => blocks[0];
export const defaultBlockComparator = (a: BlockFact, b: BlockFact) => -1;

// TODO: Rename to RequestService?
export default class FetchService {
  private pendingKeyedFetches = new Set<unknown>();

  constructor(private ctx: Context) {}

  // public listen(verifier:Verifier, {}?:FetchOptions, cb?: (body: Uint8Array) => void) {}
  // public listenBlock(verifier:Verifier, {}?:FetchOptions, cb?: (block: BlockFact) => void) {}
  // public fetch(verifier:Verifier, {}?:FetchOptions): Promise<Uint8Array> {}

  // TODO: Rename to query?
  public fetch(
    verifier: Verifier,
    {
      detail,
      dedupKey,
      internalIncentive,
      externalIncentive,
      bid,
      blockSelector,
      blockComparator,
      verify,
      abortSignal,
    }: FetchOptions,
    cb?: (block: BlockFact) => void,
  ) {
    if (abortSignal?.aborted) {
      return;
    }

    // console.log(
    //   `Fetching block`,
    //   { ...verifier, ...this.ctx.get(QaDebugger).debugQuestion(verifier) },
    // );

    internalIncentive = 1n;
    if (internalIncentive !== undefined) {
      // this.ctx.get(GenerationService).enqueueGeneration(
      //   verifier,
      //   detail,
      //   Number(internalIncentive),
      // );

      // TODO: We don't need the contract/generator before starting execution. Just request it like any other input.

      // const gen = this.ctx.get(LocalGenerationService).getGenerator(
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
      this.ctx.get(BlockBuilder).publish({
        outputs: [{ verifier, amount: externalIncentive, detail: EMPTY_ARR }],
      }, 0);
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

    let onState: (block: BlockFact) => boolean;
    if (cb !== undefined) {
      let prevBlock: BlockFact | undefined;
      onState = (block: BlockFact) => {
        if (
          prevBlock === undefined ||
          (blockComparator || defaultBlockComparator)(prevBlock, block)
        ) {
          prevBlock = block;
          cb(block);
        }
        return true;
      };

      this.ctx.get(BlockService).satisfactionMonitor.on(verifier, onState);
    }

    let released = false;
    const release = () => {
      if (released) {
        throw new Error(`Cannot release multiple times`);
      }
      released = true;

      if (internalIncentive !== undefined) {
        // this.ctx.get(GenerationService).enqueueGeneration(
        //   verifier,
        //   detail,
        //   0,
        // );
      }

      if (externalIncentive !== undefined) {
        // TODO: Claim our incentive to get it back
      }

      if (cb !== undefined) {
        this.ctx.get(BlockService).satisfactionMonitor.on(verifier, onState);
      }
    };

    abortSignal?.addEventListener('abort', release);

    return {
      release, // getTotalInternalIncentive: () =>
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
