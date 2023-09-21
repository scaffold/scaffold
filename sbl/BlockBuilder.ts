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
import BlockService, { BASE_WORK } from './BlockService.ts';
import { arrEquals } from './util/buffer.ts';
import { accountHash, epochHash, frontierHash, trueHash } from './constants.ts';
import KeyService from './KeyService.ts';
import FrontierService from '~/sbl/FrontierService.ts';
import { BlockFact, BlockSetFact } from '~/sbl/FactMeta.ts';
import { MaybePromise } from '~/sbl/util/types.ts';
import FreeMarketService from '~/sbl/FreeMarketService.ts';

// const defaultTimeout = 100; // Enable block chunking
const defaultTimeout = 0; // Disable block chunking

interface BlockSpec {
  body?: Uint8Array;
  inputs?: { block: BlockFact; outputIdx: number; amount: bigint }[];
  refs?: BlockFact[];
  satisfies?: Verifier[];
  outputs?: BlockOutput[];
  frontierVote?: BlockSetFact;
  frontierLevel?: number;
}

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

  public buildBlock(spec: BlockSpec): Block {
    // 1. Gather all satisfying (positive?) inputs that someone else could claim (which doesn't include signature satisfaction).
    // 2. For remaining output value, input to/from account balance (signature satisfaction).

    let difference = 0n;

    // const verifier_hash = Hash.digest(Verifier.encode(verifier));
    // const inputs = this.ctx.get(IncentiveRegistry).pop(verifier_hash)?.inputs ||
    //   [];

    const inputBlocks = spec.inputs ?? [];
    const outputs = spec.outputs ?? [];

    for (const block of spec.refs ?? []) {
      inputBlocks.push({ block, outputIdx: -1, amount: 0n });
    }

    for (const verifier of spec.satisfies ?? []) {
      let added = false;
      for (
        const { block, idx } of this.ctx.get(BlockService)
          .getBlocksByOutput(verifier)
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
          added = true;

          if (
            Hash.equals(block.outputs[idx].verifier.contract_hash, epochHash)
          ) {
            difference += 1000000n;
          }
        }
      }

      if (!added) {
        const block = this.publish({
          outputs: [{ verifier, amount: 0n, detail: new Uint8Array() }],
        }, 0);
        inputBlocks.push({ block, outputIdx: 0, amount: 0n });
      }
    }

    if (
      outputs.some((output) =>
        Hash.equals(output.verifier.contract_hash, frontierHash)
      )
    ) {
      throw new Error(`Unexpected frontier output on an unfinished block!`);
    }
    outputs.push({
      verifier: {
        contract_hash: frontierHash,
        params: FrontierTreeParams.encode({ level: spec.frontierLevel ?? 0 }),
      },
      amount: 10n,
      detail: FrontierTreeDetail.encode({
        // input_tree_root: ZERO_HASH,
        // output_tree_root: ZERO_HASH,

        // input_count: 0,
        // output_count: 0,

        // block_count: 1,
        // claimed_work: this.computeWork(inputBlocks, outputs),
      }),
    });

    difference += inputBlocks.reduce((acc, cur) => acc + cur.amount, 0n);
    difference -= outputs.reduce((acc, cur) => acc + cur.amount, 0n);

    if (difference < 0n) {
      const accountInputs = this.ctx.get(BlockService).getBlocksByOutput(
        this.selfAccountVerifier,
      );
      for (const { block, idx } of accountInputs) {
        const amount = block.outputs[idx].amount;
        if (amount > 0n) {
          inputBlocks.push({ block, outputIdx: idx, amount });
          difference += amount;
          if (difference >= 0n) {
            break;
          }
        }
      }
    }

    if (difference > 0n) {
      outputs.push({
        verifier: this.selfAccountVerifier,
        amount: difference,
        detail: new Uint8Array(),
      });
    } else if (difference < 0n) {
      // TODO: Only output what we actually have
      if (this.ctx.config.enableValidation) {
        throw new Error('INSUFFICIENT_COINS');
      }
    }

    const inputs = inputBlocks.map((input) => ({
      block_hash: input.block.hash,
      output_idx: input.outputIdx,
    }));

    const frontierVote = spec.frontierVote
      ? spec.frontierVote
      : this.ctx.get(FrontierService).getBlockVote(inputBlocks);

    // TODO: Can bundle multiple blocks without bodies
    const body = spec.body ?? new Uint8Array();

    let timestamp = BigInt(this.ctx.config.timeProvider.now());
    inputBlocks.forEach((input) => {
      // TODO: No need to look these blocks up; just store them in IncentiveRegistry
      const inputTs = input.block.timestamp;
      if (inputTs >= timestamp) {
        // timestamp = inputTs + 1n;
        timestamp = inputTs;
      }
    });

    return {
      inputs,
      outputs,
      frontier_vote: frontierVote ? frontierVote.hash : ZERO_HASH,
      body,
      // claimed_work: claimedWork,
      // is_free_market: true,
      timestamp,
    };
  }

  private computeWork(
    inputs: { block: BlockFact; outputIdx: number; amount: bigint }[],
    outputs: BlockOutput[],
  ) {
    const inputFreeMarketSum = inputs.reduce((acc, cur) => {
      const { verifier } = cur.block.outputs[cur.outputIdx];
      if (this.ctx.get(FreeMarketService).isFreeMarket(verifier)) {
        return acc + cur.amount;
      } else {
        return acc;
      }
    }, BASE_WORK);

    const outputCharitySum = outputs.reduce(
      (acc, { amount, verifier }) =>
        this.ctx.get(FreeMarketService).isCharity(verifier)
          ? acc + amount
          : acc,
      0n,
    );

    return inputFreeMarketSum > outputCharitySum
      ? inputFreeMarketSum - outputCharitySum
      : 0n;
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

    let mergeable = (spec.body === undefined || bb.body === undefined) &&
      (spec.frontierLevel === undefined || bb.frontierLevel === undefined);

    if (
      mergeable && spec.frontierVote !== undefined &&
      bb.frontierVote !== undefined
    ) {
      const mergedVote = this.ctx.get(FrontierService).mergeFrontierVotes(
        spec.frontierVote,
        bb.frontierVote,
      );
      if (mergedVote !== undefined) {
        bb.frontierVote = mergedVote;
      } else {
        // Frontier votes are not mergeable
        mergeable = false;
      }
    }

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
