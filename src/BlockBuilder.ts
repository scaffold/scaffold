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
import { BlockFact, FactSource } from './FactMeta.ts';
import { MaybePromise } from './util/types.ts';
import FrontierService2 from './FrontierService2.ts';
import { arrEquals, EMPTY_ARR } from './util/buffer.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import WeightService from './WeightService.ts';
import GenerationService from './GenerationService.ts';
import { assert, todo } from './util/functional.ts';
import FrontierChainService from './FrontierChainService.ts';

const defaultTimeout = 100; // Enable block chunking
// const defaultTimeout = 0; // Disable block chunking
const enableBlockMerging = false;

export interface InputSpec {
  block: BlockFact;
  outputIdx: number;
  amount: bigint;
}

// export interface FrontierSpec {
//   level: number;
//   inputs: InputSpec[];
// }

export interface BlockDraft {
  frontierVote?: BlockFact;
  frontierLevel?: number;
  refs?: BlockFact[];
  inputs?: InputSpec[];
  satisfies?: (Verifier & { detail?: Uint8Array })[];
  outputs?: Omit<BlockOutput, 'groupIdx'>[];
  result?: Uint8Array;
  // frontierSpec?: FrontierSpec;
  // timestampGte?: bigint;
}

// TODO: If a block is rejected for double-spending or doesn't become canonical, we gotta re-build a new block that doesn't include the problematic inputs.
export default class BlockBuilder {
  private selfAccountVerifier: Verifier;

  private pubsPerMs = 0;

  // We can do this because adding more inputs, outputs, or a body should never remove validity
  private drafts: BlockDraft[] = [];
  private emitAt = Infinity;
  private emitTimeout = -1;
  private resolvers: ((block: BlockFact) => void)[] = [];

  constructor(private ctx: Context) {
    this.selfAccountVerifier = {
      contract_hash: accountHash,
      params: AccountContractParams.encode({
        publicKey: this.ctx.get(KeyService).getSelfPublicKey(),
      }),
    };
  }

  public buildBlock(drafts: BlockDraft[]): Block {
    // 1. Gather all satisfying (positive?) inputs that someone else could claim (which doesn't include signature satisfaction).
    // 2. For remaining output value, input to/from account balance (signature satisfaction).

    // const verifier_hash = Hash.digest(Verifier.encode(verifier));
    // const inputs = this.ctx.get(IncentiveRegistry).pop(verifier_hash)?.inputs ||
    //   [];

    // drafts.sort((a, b) =>
    //   Number(b.result !== undefined) - Number(a.result !== undefined)
    // );

    let frontierLevel: number | undefined;
    const refBlocks: BlockFact[] = [];
    const inputs: (InputSpec & BlockInput)[] = [];
    const outputs: BlockOutput[] = [];
    const results: Uint8Array[] = [];

    let groupIdx = 0;
    for (const draft of drafts) {
      if (draft.frontierLevel !== undefined) {
        if (frontierLevel === undefined) {
          frontierLevel = draft.frontierLevel;
        } else if (frontierLevel !== draft.frontierLevel) {
          throw new Error(`Cannot merge different frontier levels!`);
        }
      }

      if (draft.refs !== undefined) {
        for (const ref of draft.refs) {
          refBlocks.push(ref);
        }
      }

      if (draft.inputs !== undefined) {
        for (const input of draft.inputs) {
          inputs.push({ ...input, blockHash: input.block.hash, groupIdx });
        }
      }

      if (draft.satisfies !== undefined) {
        for (const satisfaction of draft.satisfies) {
          this.collectInputs(
            satisfaction,
            true,
            (input) =>
              inputs.push({ ...input, blockHash: input.block.hash, groupIdx }),
          );
        }
      }

      if (draft.outputs !== undefined) {
        for (const output of draft.outputs) {
          outputs.push({ ...output, groupIdx });
        }
      }

      results.push(draft.result ?? EMPTY_ARR);

      groupIdx++;
    }

    let ioDelta = 0n;

    const addFrontierOutput = !outputs.some((output) =>
      Hash.equals(output.verifier.contract_hash, frontierHash)
    );
    const frontierOutputAmount = 10n;

    if (addFrontierOutput) {
      ioDelta -= frontierOutputAmount;
    } else {
      if (this.ctx.config.allowSpecifiedFrontierOutputs) {
        console.warn(`Unexpected frontier output on an unfinished block!`);
      } else {
        throw new Error(`Unexpected frontier output on an unfinished block!`);
      }
    }

    ioDelta += inputs.reduce((acc, cur) => acc + cur.amount, 0n);
    ioDelta -= outputs.reduce((acc, cur) => acc + cur.amount, 0n);

    while (ioDelta < 0n) {
      const input = this.ctx.get(GenerationService)
        .claimInput(this.selfAccountVerifier);
      if (input === undefined) {
        break;
      }

      if (input.amount > 0n) {
        // TODO: Handle groups without any result
        results.push(EMPTY_ARR);
        inputs.push({
          ...input,
          blockHash: input.block.hash,
          groupIdx: groupIdx++,
        });
        assert(results.length === groupIdx);
        ioDelta += input.amount;
      }
    }

    if (ioDelta > 0n) {
      results.push(EMPTY_ARR);
      outputs.push({
        verifier: this.selfAccountVerifier,
        amount: ioDelta,
        detail: EMPTY_ARR,
        groupIdx: groupIdx++,
      });
      assert(results.length === groupIdx);
    } else if (ioDelta < 0n) {
      // TODO: Only output what we actually have
      if (this.ctx.config.enableValidation) {
        throw new Error('INSUFFICIENT_COINS');
      }
    }

    const refs = refBlocks.map((block) => block.hash);

    const frontierVote = this.ctx.get(FrontierChainService).getVote([
      ...inputs,
      ...refBlocks.map((ref) => ({ block: ref })),
    ]).hash;

    if (addFrontierOutput) {
      const level = frontierLevel ?? 0;
      // const amount = BigInt(
      //   Math.round(10 * Math.pow(frontierInputCount * 0.75, level)),
      // );

      results.push(EMPTY_ARR);
      outputs.push({
        verifier: {
          contract_hash: frontierHash,
          params: FrontierTreeParams.encode({ level }),
        },
        amount: frontierOutputAmount,
        detail: FrontierTreeDetail.encode({
          treeWeights: this.ctx.get(FrontierService2)
            .mergeTreeWeights(inputs, outputs, frontierVote),
          // input_tree_root: ZERO_HASH,
          // output_tree_root: ZERO_HASH,

          // input_count: 0,
          // output_count: 0,

          // block_count: 1,
          // claimed_work: this.computeWork(inputs, outputs),
        }),
        groupIdx: groupIdx++,
      });
      assert(results.length === groupIdx);
    }

    let timestamp = BigInt(this.ctx.config.timeProvider.now());
    if (this.ctx.config.graphParameters.enforceTimestampMonotonicity) {
      if (!Hash.equals(frontierVote, ZERO_HASH)) {
        const frontierBlock = this.ctx.get(BlockService)
          .get(frontierVote, false);
        if (frontierBlock === undefined) {
          throw new Error(`Unknown frontier vote!`);
        }
        const inputTs = frontierBlock.timestamp +
          this.ctx.config.graphParameters.minimumGenerationTime;
        if (inputTs > timestamp) {
          timestamp = inputTs;
        }
      }
      for (const block of refBlocks) {
        const inputTs = block.timestamp +
          this.ctx.config.graphParameters.minimumGenerationTime;
        if (inputTs > timestamp) {
          timestamp = inputTs;
        }
      }
      for (const { block } of inputs) {
        const inputTs = block.timestamp +
          this.ctx.config.graphParameters.minimumGenerationTime;
        if (inputTs > timestamp) {
          timestamp = inputTs;
        }
      }
    }

    return { frontierVote, refs, inputs, outputs, results, timestamp };
  }

  private collectInputs(
    satisfaction: Verifier & { detail?: Uint8Array },
    publishStub: boolean,
    addInput: (input: InputSpec) => void,
  ) {
    for (
      const { block, idx } of this.ctx.get(BlockService)
        .getBlocksByOutput(satisfaction)
    ) {
      if (
        block.outputClaims[idx].length === 0 &&
        block.outputs[idx].amount >= 0n
      ) {
        addInput({ block, outputIdx: idx, amount: block.outputs[idx].amount });
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
      addInput({
        block,
        outputIdx: block.outputs.findIndex((x) =>
          this.ctx.get(BlockService).areVerifiersEqual(x.verifier, satisfaction)
        ),
        amount: 0n,
      });
    }
  }

  private doEmit = () => {
    const drafts = this.drafts;
    this.drafts = [];
    const resolvers = this.resolvers;
    this.resolvers = [];
    const fact = this.ctx.get(BlockService).create(this.buildBlock(drafts));
    resolvers.forEach((fn) => fn(fact));
  };

  public publish(draft: BlockDraft, timeout: 0): BlockFact;
  public publish(draft: BlockDraft, timeout?: number): MaybePromise<BlockFact>;
  public publish(draft: BlockDraft, timeout?: number) {
    if (!enableBlockMerging) {
      return this.ctx.get(BlockService).create(this.buildBlock([draft]));
    }

    timeout ??= defaultTimeout;
    if (timeout < 0) {
      throw new Error(`Block publish timeout cannot be negative!`);
    }

    this.pubsPerMs++;

    if (this.drafts.length === 0) {
      if (timeout === 0) {
        return this.ctx.get(BlockService).create(this.buildBlock([draft]));
      } else {
        this.drafts.push(draft);
        this.emitAt = this.ctx.config.timeProvider.now() + timeout;
        this.emitTimeout = this.ctx.config.timeProvider
          .setTimeout(this.doEmit, timeout);
        if (this.resolvers.length !== 0) {
          throw new Error(
            `Resolvers should be empty if building block isn't set!`,
          );
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      }
    }

    const existingFrontierLevel = this.drafts
      .find((d) => d.frontierLevel !== undefined)?.frontierLevel;
    const mergeable = (existingFrontierLevel === undefined ||
      draft.frontierLevel === undefined ||
      existingFrontierLevel === draft.frontierLevel) &&
      this.ctx.get(FrontierChainService).getVote(
          [...this.drafts, draft].flatMap((d) => [
            ...d.inputs ?? [],
            ...d.refs?.map((ref) => ({ block: ref })) ?? [],
          ]),
        ) !== undefined;

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
      this.drafts.push(draft);

      if (timeout === 0) {
        // Mergeable and we need to emit immediately:
        // Merge and emit; clear building block.
        this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
        const drafts = this.drafts;
        this.drafts = [];
        const resolvers = this.resolvers;
        this.resolvers = [];
        const fact = this.ctx.get(BlockService).create(this.buildBlock(drafts));
        resolvers.forEach((fn) => fn(fact));
        return fact;
      } else {
        // Mergeable and we can wait to emit:
        // Merge and re-schedule the emit if we're reducing it.
        const emitAt = this.ctx.config.timeProvider.now() + timeout;
        if (emitAt < this.emitAt) {
          this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
          this.emitAt = emitAt;
          this.emitTimeout = this.ctx.config.timeProvider
            .setTimeout(this.doEmit, timeout);
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      }
    } else {
      if (timeout === 0) {
        // Not mergeable and we need to emit immediately:
        // Just emit the current block now and leave the other one to emit later.
        return this.ctx.get(BlockService).create(this.buildBlock([draft]));
      } else {
        // Not mergeable and we can wait to emit:
        // Emit the block that should be emitted first; leave the other one for later.
        const emitAt = this.ctx.config.timeProvider.now() + timeout;
        if (emitAt < this.emitAt) {
          // Emit the current block now and leave the building one for later.
          return this.ctx.get(BlockService).create(this.buildBlock([draft]));
        } else {
          // Emit the building block now and leave the current one for later.
          this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
          const drafts = this.drafts;
          this.drafts = [draft];
          this.emitAt = emitAt;
          this.emitTimeout = this.ctx.config.timeProvider
            .setTimeout(this.doEmit, timeout);
          const bbResolvers = this.resolvers;
          return new Promise((resolve) => {
            this.resolvers = [resolve];
            const fact = this.ctx.get(BlockService)
              .create(this.buildBlock(drafts));
            bbResolvers.forEach((fn) => fn(fact));
          });
        }
      }
    }
  }
}
