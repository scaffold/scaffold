import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { Block, Verifier } from './messages.ts';
import { BlockBuilder } from './BlockBuilder.ts';
import { EMPTY_ARR } from './util/buffer.ts';
import { Collateralization } from './FactMeta.ts';
import { arrEquals } from './util/buffer.ts';
import { FactService } from './FactService.ts';
import { FrontierHelper } from './FrontierHelper.ts';
import { WeightService } from './WeightService.ts';
import { GenesisService } from './GenesisService.ts';
import { OutputClaim } from './BlockMeta.ts';

export enum FetchMode {
  // Selects the first valid block satisfying the given verifier.
  // Doesn't update unless the block becomes uncanonical? or invalid, in which case it resets to the most canonical known block.
  Fastest,

  // Selects the most canonical valid block satisfying the given verifier.
  // Updates if we find a stronger block.
  Strongest,

  // Selects the least positively canonical valid block satisfying the given verifier.
  // Updates if the block becomes uncanonical, invalid, or we get a newer block.
  Latest,

  // Selects all valid blocks satisfying the given verifier.
  // It is the user's responsibility to monitor them for validity and canonicality changes.
  All,
}

// If no callbacks are specified, just notify/incentivize the network of an upcoming fetch.

// TODO: Do we need a special case for hash inversions?

export interface FetchOptions {
  // Pass a signal to allow cancelling the request
  abortSignal?: AbortSignal;

  // If this is set, abort/cancel/release any previous fetches with the same key
  dedupKey?: unknown;

  // The amount of generation incentive to use
  incentive?: bigint;

  // Which block to select, if there's multiple candidates
  mode?: FetchMode;

  // Whether to verify results before returning them
  verify?: boolean;

  // Whether to limit how fast the body callback is called; only affects the onBody callback
  debounceMs?: number;

  // Delays the body callback until its canonicality is at least this value; only affects the onBody callback
  minCanonicality?: bigint;

  // This is called whenever we create a block incentivizing our request
  onIncentiveBlock?: (block: BlockFact, outputIdx: number) => void;

  // This is called whenever we generate or receive a block fulfilling our request
  onResponseBlock?: (block: BlockFact, groupIdx: number) => void;

  // This is called whenever we generate or receive a block collateralizing the most recently called response block
  onResponseCollateral?: (collateral: Collateralization) => void;

  // TODO: Also need to expose (perhaps via another api):
  // The descending frontier chain
  // The total derived work / canonicality

  // This is called whenever we generate or receive a more up-to-date body, subject to debouncing and the canonicality threshold.
  onBody?: (body?: Uint8Array) => void;
}

export class FetchService {
  private pendingKeyedFetches = new Map<unknown, unknown>();

  constructor(private ctx: Context) {}

  public fetch(verifier: Verifier, options: FetchOptions) {
    options.mode ??= FetchMode.Fastest;

    const {
      abortSignal,
      dedupKey,
      incentive,
      mode,
      verify,
      debounceMs,
      minCanonicality,
      onIncentiveBlock,
      onResponseBlock,
      onResponseCollateral,
      onBody,
    } = options;

    if (abortSignal?.aborted) {
      return { release: () => {} };
    }

    const got = this.ctx.get(BlockService).getBlocksByVerifier(verifier);
    if (got.length > 0) {
      if (onBody !== undefined) {
        const last = got[got.length - 1];
        onBody(last.block.bodies[last.groupIdx]);
      }
    } else {
      const amount = incentive ?? this.ctx.config.getDepositIncentive(verifier);
      if (amount >= 0n) {
        this.ctx.get(BlockBuilder).publishPersistentDraft({
          outputs: [{ verifier, amount, detail: EMPTY_ARR }],
          timeout: 0,
          onBlock: onIncentiveBlock !== undefined
            ? (block, groupIdx) =>
              onIncentiveBlock(
                block,
                block.outputs.findIndex((x) => x.groupIdx === groupIdx),
              )
            : undefined,
        });
      }
    }

    let onState: (claim?: OutputClaim) => boolean;
    let watchItvl: number | undefined;
    if (onBody !== undefined || onResponseBlock !== undefined) {
      let prevBody: Uint8Array | undefined;
      onState = (claim) => {
        if (claim !== undefined) {
          const input = claim.block.inputs[claim.inputIdx];
          onResponseBlock?.(claim.block, input.groupIdx);

          const body = claim.block.bodies[input.groupIdx];
          if (prevBody === undefined || !arrEquals(body, prevBody)) {
            prevBody = body;
            onBody?.(body);
          }
        } else {
          if (prevBody !== undefined) {
            prevBody = undefined;
            onBody?.(undefined);
          }
        }

        return true;
      };

      // TODO: Enable this and disable the interval-based monitoring
      // this.ctx.get(BlockService).satisfactionMonitor.on(verifier, onState);

      watchItvl = this.ctx.config.timeProvider.setInterval(() => {
        const genesis = this.ctx.get(GenesisService).getGenesisBlock();
        // TODO: Use all leaves
        const leaves =
          this.ctx.get(WeightService).getDescendant(genesis).leaves;
        const base = leaves[leaves.length - 1];
        const claims = base !== undefined
          ? FrontierHelper.findOutputs(base, verifier, false)
            .flatMap((x) => this.ctx.get(BlockService).getClaims(x))
            .filter((x) => this.ctx.get(WeightService).isCanonical(x.block))
          : [];
        onState(claims[claims.length - 1]);

        // const blocks = this.ctx.get(FactService).hackyGetBlocksMatching();
        // for (const block of blocks) {
        //   if (
        //     block.canonicality >= 0n &&
        //     (bestBlock === undefined ||
        //       (mode === FetchMode.Latest
        //         ? block.canonicality <= bestBlock.canonicality
        //         : block.canonicality > bestBlock.canonicality)) &&
        //     block.inputs.some((input) => {
        //       const inputBlock = this.ctx.get(BlockService)
        //         .get(input.blockHash, false);
        //       return inputBlock !== undefined &&
        //         this.ctx.get(BlockService).areVerifiersEqual(
        //           inputBlock.outputs[input.outputIdx].verifier,
        //           verifier,
        //         );
        //     })
        //   ) {
        //     bestBlock = block;
        //   }
        // }

        // onState(bestBlock);
      }, 100);
    }

    let released = false;
    const release = () => {
      if (released) {
        throw new Error(`Cannot release multiple times`);
      }
      released = true;

      if (watchItvl !== undefined) {
        // this.ctx.get(BlockService).satisfactionMonitor.off(verifier, onState);
        this.ctx.config.timeProvider.clearInterval(watchItvl);
      }
    };

    abortSignal?.addEventListener('abort', release);

    return { release };
  }
}
