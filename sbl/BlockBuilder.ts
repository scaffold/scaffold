import Hash, { ZERO_HASH } from './util/Hash.ts';
import Context from './Context.ts';
import {
  AccountContractParams,
  Block,
  BlockInput,
  BlockOutput,
  FrontierTreeDetail,
  FrontierTreeParams,
  Verifier,
} from './messages.ts';
// import IncentiveCalculator from './IncentiveCalculator.ts';
import BlockService from './BlockService.ts';
import { accountHash, collateralHash, frontierHash } from './constants.ts';
import KeyService from './KeyService.ts';
import { BlockFact, FactSource } from '~/sbl/FactMeta.ts';
import { MaybePromise } from '~/sbl/util/types.ts';
import FrontierService2 from '~/sbl/FrontierService2.ts';
import UnclaimedOutputService from '~/sbl/UnclaimedOutputService.ts';
import { arrEquals, EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { frontierInputCount } from '~/sbl/contracts/FrontierContract.ts';
import WeightService from '~/sbl/WeightService.ts';

const defaultTimeout = 100; // Enable block chunking
// const defaultTimeout = 0; // Disable block chunking
const enableBlockMerging = false;

export interface InputSpec {
  block: BlockFact;
  outputIdx: number;
  amount: bigint;
}
export interface FrontierSpec {
  level: number;
  inputs: InputSpec[];
}
export interface BlockSpec {
  body?: Uint8Array;
  inputs?: InputSpec[];
  refs?: BlockFact[];
  satisfies?: (Verifier & { detail?: Uint8Array })[];
  outputs?: BlockOutput[];
  frontierVote?: BlockFact;
  frontierLevel?: number;
  frontierSpec?: FrontierSpec;
  // timestampGte?: bigint;
}

// TODO: If a block is rejected for double-spending or doesn't become canonical, we gotta re-build a new block that doesn't include the problematic inputs.
export default class BlockBuilder {
  private selfAccountVerifier: Verifier;

  private pubsPerMs = 0;

  // We can do this because adding more inputs, outputs, or a body should never remove validity
  private buildingBlock?: BlockSpec;
  private emitAt = Infinity;
  private emitTimeout = -1;
  private resolvers: ((block: BlockFact) => void)[] = [];

  constructor(private ctx: Context) {
    this.selfAccountVerifier = {
      contract_hash: accountHash,
      params: AccountContractParams.encode({
        public_key: this.ctx.get(KeyService).getSelfPublicKey(),
      }),
    };
  }

  public buildBlock(spec: BlockSpec, ioDelta = 0n): Block {
    // 1. Gather all satisfying (positive?) inputs that someone else could claim (which doesn't include signature satisfaction).
    // 2. For remaining output value, input to/from account balance (signature satisfaction).

    // const verifier_hash = Hash.digest(Verifier.encode(verifier));
    // const inputs = this.ctx.get(IncentiveRegistry).pop(verifier_hash)?.inputs ||
    //   [];

    const refBlocks = spec.refs ?? [];
    const inputBlocks = spec.inputs ?? [];
    const outputs = spec.outputs ?? [];

    for (const satisfaction of spec.satisfies ?? []) {
      this.collectInputs(inputBlocks, satisfaction, true);
    }

    if (
      outputs.some((output) =>
        Hash.equals(output.verifier.contract_hash, frontierHash)
      )
    ) {
      if (this.ctx.config.allowSpecifiedFrontierOutputs) {
        console.warn(`Unexpected frontier output on an unfinished block!`);
      } else {
        throw new Error(`Unexpected frontier output on an unfinished block!`);
      }
    } else {
      const level = spec.frontierLevel ?? 0;
      // const amount = BigInt(
      //   Math.round(10 * Math.pow(frontierInputCount * 0.75, level)),
      // );
      const amount = 10n;

      outputs.push({
        verifier: {
          contract_hash: frontierHash,
          params: FrontierTreeParams.encode({ level }),
        },
        amount,
        detail: FrontierTreeDetail.encode({
          tree_weight: inputBlocks.reduce(
            (acc, cur) => acc + cur.block.frontierDetail.tree_weight,
            this.ctx.get(WeightService).getSelfWeight({
              source: FactSource.Local,
              inputs: inputBlocks.map((input) => ({
                block_hash: input.block.hash,
                output_idx: input.outputIdx,
              })),
              outputs,
            }).minWeight,
          ),
          // input_tree_root: ZERO_HASH,
          // output_tree_root: ZERO_HASH,

          // input_count: 0,
          // output_count: 0,

          // block_count: 1,
          // claimed_work: this.computeWork(inputBlocks, outputs),
        }),
      });
    }

    ioDelta += inputBlocks.reduce((acc, cur) => acc + cur.amount, 0n);
    ioDelta -= outputs.reduce((acc, cur) => acc + cur.amount, 0n);

    while (ioDelta < 0n) {
      const input = this.ctx.get(UnclaimedOutputService)
        .claimNow(this.selfAccountVerifier);
      if (input === undefined) {
        break;
      }

      if (input.amount > 0n) {
        inputBlocks.push(input);
        ioDelta += input.amount;
      }
    }

    if (ioDelta > 0n) {
      outputs.push({
        verifier: this.selfAccountVerifier,
        amount: ioDelta,
        detail: EMPTY_ARR,
      });
    } else if (ioDelta < 0n) {
      // TODO: Only output what we actually have
      if (this.ctx.config.enableValidation) {
        throw new Error('INSUFFICIENT_COINS');
      }
    }

    const refs = refBlocks.map((block) => block.hash);
    const inputs = inputBlocks.map((input) => ({
      block_hash: input.block.hash,
      output_idx: input.outputIdx,
    }));

    const frontierVote = spec.frontierVote?.hash ??
      this.ctx.get(FrontierService2).getBlockVote(inputBlocks);

    // TODO: Can bundle multiple blocks without bodies
    const body = spec.body ?? new Uint8Array();

    let timestamp = BigInt(this.ctx.config.timeProvider.now());
    for (const block of refBlocks) {
      const inputTs = block.timestamp;
      if (inputTs >= timestamp) {
        // timestamp = inputTs + 1n;
        timestamp = inputTs;
      }
    }
    for (const { block } of inputBlocks) {
      const inputTs = block.timestamp;
      if (inputTs >= timestamp) {
        // timestamp = inputTs + 1n;
        timestamp = inputTs;
      }
    }

    return {
      refs,
      inputs,
      outputs,
      frontier_vote: frontierVote,
      body,
      // claimed_work: claimedWork,
      // is_free_market: true,
      timestamp,
    };
  }

  public collectInputs(
    inputBlocks: InputSpec[],
    satisfaction: Verifier & { detail?: Uint8Array },
    publishStub: boolean,
  ) {
    for (
      const { block, idx } of this.ctx.get(BlockService)
        .getBlocksByOutput(satisfaction)
    ) {
      if (
        block.outputClaims[idx].length === 0 &&
        block.outputs[idx].amount >= 0n
      ) {
        inputBlocks.push({
          block,
          outputIdx: idx,
          amount: block.outputs[idx].amount,
        });
        publishStub = false;
      }
    }

    if (publishStub) {
      const block = this.publish({
        outputs: [{
          verifier: satisfaction,
          amount: 0n,
          detail: satisfaction.detail ?? EMPTY_ARR,
        }],
      }, 0);
      inputBlocks.push({ block, outputIdx: 0, amount: 0n });
    }
  }

  private doEmit = () => {
    const bb = this.buildingBlock;
    if (bb === undefined) {
      throw new Error(`Can't emit an undefined block!`);
    }
    this.buildingBlock = undefined;
    const resolvers = this.resolvers;
    this.resolvers = [];
    const fact = this.ctx.get(BlockService).create(this.buildBlock(bb));
    resolvers.forEach((fn) => fn(fact));
  };

  public publish(spec: BlockSpec, timeout: 0): BlockFact;
  public publish(spec: BlockSpec, timeout?: number): MaybePromise<BlockFact>;
  public publish(spec: BlockSpec, timeout?: number) {
    if (!enableBlockMerging) {
      return this.ctx.get(BlockService).create(this.buildBlock(spec));
    }

    timeout ??= defaultTimeout;
    if (timeout < 0) {
      throw new Error(`Block publish timeout cannot be negative!`);
    }

    this.pubsPerMs++;

    if (this.buildingBlock === undefined) {
      if (timeout === 0) {
        return this.ctx.get(BlockService).create(this.buildBlock(spec));
      } else {
        this.buildingBlock = spec;
        this.emitAt = this.ctx.config.timeProvider.now() + timeout;
        this.emitTimeout = this.ctx.config.timeProvider.setTimeout(
          this.doEmit,
          timeout,
        );
        if (this.resolvers.length !== 0) {
          throw new Error(
            `Resolvers should be empty if building block isn't set!`,
          );
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      }
    }

    const bb = this.buildingBlock;

    const mergeable = (spec.body === undefined || bb.body === undefined ||
      arrEquals(spec.body, bb.body)) &&
      (spec.frontierVote === undefined || bb.frontierVote === undefined ||
        spec.frontierVote === bb.frontierVote) &&
      (spec.frontierLevel === undefined || bb.frontierLevel === undefined ||
        spec.frontierLevel === bb.frontierLevel);

    // if (
    //   mergeable && spec.frontierVote !== undefined &&
    //   bb.frontierVote !== undefined
    // ) {
    //   const mergedVote = this.ctx.get(FrontierService2)
    //     .mergeFrontierVotes(spec.frontierVote, bb.frontierVote);
    //   if (mergedVote !== undefined) {
    //     bb.frontierVote = mergedVote;
    //   } else {
    //     // Frontier votes are not mergeable
    //     mergeable = false;
    //   }
    // }

    if (mergeable) {
      bb.body ??= spec.body;
      if (spec.inputs !== undefined) {
        bb.inputs = bb.inputs !== undefined
          ? bb.inputs.concat(spec.inputs)
          : spec.inputs;
      }
      if (spec.refs !== undefined) {
        bb.refs = bb.refs !== undefined ? bb.refs.concat(spec.refs) : spec.refs;
      }
      if (spec.satisfies !== undefined) {
        bb.satisfies = bb.satisfies !== undefined
          ? bb.satisfies.concat(spec.satisfies)
          : spec.satisfies;
      }
      if (spec.outputs !== undefined) {
        bb.outputs = bb.outputs !== undefined
          ? bb.outputs.concat(spec.outputs)
          : spec.outputs;
      }
      bb.frontierVote ??= spec.frontierVote;
      bb.frontierLevel ??= spec.frontierLevel;

      if (timeout === 0) {
        // Mergeable and we need to emit immediately:
        // Merge and emit; clear building block.
        this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
        this.buildingBlock = undefined;
        const resolvers = this.resolvers;
        this.resolvers = [];
        const fact = this.ctx.get(BlockService).create(this.buildBlock(bb));
        resolvers.forEach((fn) => fn(fact));
        return fact;
      } else {
        // Mergeable and we can wait to emit:
        // Merge and re-schedule the emit if we're reducing it.
        const emitAt = this.ctx.config.timeProvider.now() + timeout;
        if (emitAt < this.emitAt) {
          this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
          this.emitAt = emitAt;
          this.emitTimeout = this.ctx.config.timeProvider.setTimeout(
            this.doEmit,
            timeout,
          );
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      }
    } else {
      if (timeout === 0) {
        // Not mergeable and we need to emit immediately:
        // Just emit the current block now and leave the other one to emit later.
        return this.ctx.get(BlockService).create(this.buildBlock(spec));
      } else {
        // Not mergeable and we can wait to emit:
        // Emit the block that should be emitted first; leave the other one for later.
        const emitAt = this.ctx.config.timeProvider.now() + timeout;
        if (emitAt < this.emitAt) {
          // Emit the current block now and leave the building one for later.
          return this.ctx.get(BlockService).create(this.buildBlock(spec));
        } else {
          // Emit the building block now and leave the current one for later.
          this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
          this.buildingBlock = spec;
          this.emitAt = emitAt;
          this.emitTimeout = this.ctx.config.timeProvider.setTimeout(
            this.doEmit,
            timeout,
          );
          const bbResolvers = this.resolvers;
          return new Promise((resolve) => {
            this.resolvers = [resolve];
            const fact = this.ctx.get(BlockService).create(this.buildBlock(bb));
            bbResolvers.forEach((fn) => fn(fact));
          });
        }
      }
    }
  }
}
