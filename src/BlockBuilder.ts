import { Hash, ZERO_HASH } from './util/Hash.ts';
import { Context } from './Context.ts';
import {
  AccountContractParams,
  Block,
  BlockInput,
  BlockOutput,
  FrontierTreeDetail,
  FrontierTreeParams,
  Verifier,
} from './messages.ts';
// import { IncentiveCalculator } from './IncentiveCalculator.ts';
import { BlockService } from './BlockService.ts';
import { accountHash, collateralHash, frontierHash } from './constants.ts';
import { KeyService } from './KeyService.ts';
import { BlockFact, FactSource, FactType } from './FactMeta.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { FrontierService2 } from './FrontierService2.ts';
import { arrEquals, EMPTY_ARR } from './util/buffer.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { WeightService } from './WeightService.ts';
import { UnspentOutputManager } from './UnspentOutputManager.ts';
import { assert, error, todo } from './util/functional.ts';
import { FrontierChainService } from './FrontierChainService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { FrontierHelper } from './FrontierHelper.ts';

const defaultTimeout = 100; // Enable block chunking
// const defaultTimeout = 0; // Disable block chunking
const enableBlockMerging = false;

export interface InputSpec {
  block: BlockFact;
  outputIdx: number;
  amount: bigint;
}
export type OutputSpec = Omit<BlockOutput, 'groupIdx'>;

// export interface FrontierSpec {
//   level: number;
//   inputs: InputSpec[];
// }

export interface BlockDraft {
  frontierVote?: BlockFact | typeof ZERO_BLOCK;
  frontierLevel?: number;
  frontierOutputAmount?: bigint;
  refs?: BlockFact[];
  inputs?: InputSpec[];
  satisfies?: (Verifier & { detail?: Uint8Array })[];
  outputs?: OutputSpec[];
  body?: Uint8Array;
  // frontierSpec?: FrontierSpec;
  // timestampGte?: bigint;

  timeout?: number;
  deadline?: number;
  onBlock?(block: BlockFact, groupIdx: number): void;
}

class RetryBuildingException extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

// TODO: If a block is rejected for double-spending or doesn't become canonical, we gotta re-build a new block that doesn't include the problematic inputs.
export class BlockBuilder {
  private selfAccountVerifier: Verifier;

  private pubsPerMs = 0;

  // We can do this because adding more inputs, outputs, or a body should never remove validity
  private drafts: BlockDraft[] = [];
  private emitAt = Infinity;
  private emitTimeout = -1;
  private resolvers: ((block: BlockFact) => void)[] = [];

  constructor(private ctx: Context) {
    this.selfAccountVerifier = {
      contractHash: accountHash,
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
    //   Number(b.body !== undefined) - Number(a.body !== undefined)
    // );

    let frontierVoteBlock: BlockFact | typeof ZERO_BLOCK | undefined;
    let frontierLevel: number | undefined;
    let frontierOutputAmount = 10n;
    const refBlocks: BlockFact[] = [];
    const inputs: (InputSpec & BlockInput)[] = [];
    const outputs: BlockOutput[] = [];
    const bodies: Uint8Array[] = [];

    let groupIdx = 0;
    for (const draft of drafts) {
      if (draft.frontierVote !== undefined) {
        if (frontierVoteBlock === undefined) {
          frontierVoteBlock = draft.frontierVote;
        } else if (frontierVoteBlock !== draft.frontierVote) {
          throw new Error(`Cannot merge different frontier votes!`);
        }
      }

      if (draft.frontierLevel !== undefined) {
        if (frontierLevel === undefined) {
          frontierLevel = draft.frontierLevel;
        } else if (frontierLevel !== draft.frontierLevel) {
          throw new Error(`Cannot merge different frontier levels!`);
        }
      }

      if (draft.frontierOutputAmount !== undefined) {
        frontierOutputAmount += draft.frontierOutputAmount;
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

      bodies.push(draft.body ?? EMPTY_ARR);

      groupIdx++;
    }

    let ioDelta = 0n;

    const addFrontierOutput = !outputs.some((output) =>
      Hash.equals(output.verifier.contractHash, frontierHash)
    );

    if (addFrontierOutput) {
      ioDelta -= frontierOutputAmount;
    } else {
      // We can't really add a frontier output in the draft because the frontier output detail needs the tree weights,
      // which need to be computed from the full inputs and outputs of the block (from multiple BlockDrafts).
      // If we decide to remove the self weight from the tree weights, this can change and we can pass the frontier output as a normal output.
      // See https://github.com/orgs/scaffold/projects/1/views/2?pane=issue&itemId=50902340
      if (this.ctx.config.allowSpecifiedFrontierOutputs) {
        console.warn(`Unexpected frontier output on an unfinished block!`);
      } else {
        throw new Error(`Unexpected frontier output on an unfinished block!`);
      }
    }

    ioDelta += inputs.reduce((acc, cur) => acc + cur.amount, 0n);
    ioDelta -= outputs.reduce((acc, cur) => acc + cur.amount, 0n);

    while (ioDelta < 0n) {
      const input = this.ctx.get(UnspentOutputManager).pop(
        this.selfAccountVerifier,
        (accountInput) =>
          this.ctx.get(FrontierChainService).getVote([
            ...inputs,
            ...refBlocks.map((ref) => ({ block: ref })),
            accountInput,
          ]) !== undefined,
      );
      if (input === undefined) {
        break;
      }

      if (input.amount > 0n) {
        // TODO: Handle groups without any result
        bodies.push(EMPTY_ARR);
        inputs.push({
          ...input,
          blockHash: input.block.hash,
          groupIdx: groupIdx++,
        });
        assert(bodies.length === groupIdx);
        ioDelta += input.amount;
      }
    }

    if (ioDelta > 0n) {
      bodies.push(EMPTY_ARR);
      outputs.push({
        verifier: this.selfAccountVerifier,
        amount: ioDelta,
        detail: EMPTY_ARR,
        groupIdx: groupIdx++,
      });
      assert(bodies.length === groupIdx);
    } else if (ioDelta < 0n) {
      // TODO: Only output what we actually have
      if (this.ctx.config.enableValidation) {
        throw new RetryBuildingException('Insufficient coins');
      }
    }

    const refs = refBlocks.map((block) => block.hash);

    frontierVoteBlock ??= this.ctx.get(FrontierChainService).getVote([
      ...inputs,
      ...refBlocks.map((ref) => ({ block: ref })),
    ]);
    if (frontierVoteBlock === undefined) {
      throw new Error(`Unmergeable inputs!`);
    }
    const frontierVote = frontierVoteBlock !== ZERO_BLOCK
      ? frontierVoteBlock.hash
      : ZERO_HASH;

    if (addFrontierOutput) {
      const level = frontierLevel ?? 0;
      // const amount = BigInt(
      //   Math.round(10 * Math.pow(frontierInputCount * 0.75, level)),
      // );

      bodies.push(EMPTY_ARR);
      // TODO: Move all of this logic to FrontierContract
      // We'll have to make the tree weights NOT include the self weight
      outputs.push({
        verifier: {
          contractHash: frontierHash,
          params: FrontierTreeParams.encode({ level }),
        },
        amount: frontierOutputAmount,
        detail: FrontierTreeDetail.encode({
          treeWeights: this.ctx.get(FrontierService2)
            .mergeTreeWeights(inputs, outputs, frontierVoteBlock),
          // input_tree_root: ZERO_HASH,
          // output_tree_root: ZERO_HASH,

          // input_count: 0,
          // output_count: 0,

          // block_count: 1,
          // claimed_work: this.computeWork(inputs, outputs),

          ...FrontierHelper.mergeTreeIo(
            inputs,
            (hash) =>
              this.ctx.get(BlockService).get(hash, false) ??
                error(`Unknown frontier child input!`),
          ),
        }),
        groupIdx: groupIdx++,
      });
      assert(bodies.length === groupIdx);
    }

    let timestamp = BigInt(this.ctx.config.timeProvider.now());
    if (this.ctx.config.graphParameters.enforceTimestampMonotonicity) {
      if (frontierVoteBlock !== undefined && frontierVoteBlock !== ZERO_BLOCK) {
        const inputTs = frontierVoteBlock.timestamp +
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

    return { frontierVote, refs, inputs, outputs, bodies, timestamp };
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
      let published = false;
      this.publishSingleDraft({
        outputs: [{
          verifier: satisfaction,
          amount: 0n,
          detail: satisfaction.detail ?? EMPTY_ARR,
        }],
        onBlock: (block, groupIdx) => {
          if (published) {
            throw new Error(`Should not publish twice!`);
          }
          published = true;

          addInput({
            block,
            outputIdx: block.outputs.findIndex((x) => x.groupIdx === groupIdx),
            amount: 0n,
          });
        },
      });
      if (!published) {
        throw new Error(`Block did not immediately publish!`);
      }
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

  public publishSingleDraft(draft: BlockDraft): BlockFact {
    if (draft.timeout !== undefined || draft.deadline !== undefined) {
      throw new Error(
        `Cannot use timeout or deadline when calling publishSingleDraft!`,
      );
    }

    const block = this.ctx.get(BlockService).create(this.buildBlock([draft]));
    if (draft.onBlock !== undefined) {
      // TODO: Make the groupIdx more robust; it shouldn't depend on the internals of buildBlock
      draft.onBlock(block, 0);
    }

    return block;
  }

  public async publishPersistentDraft(draft: BlockDraft) {
    if (draft.timeout !== undefined) {
      if (draft.deadline !== undefined) {
        throw new Error(`Cannot set both timeout and deadline!`);
      } else {
        draft.deadline = this.ctx.config.timeProvider.now() + draft.timeout;
        draft.timeout = undefined;
      }
    }

    let block: Block;
    try {
      block = this.buildBlock([draft]);
    } catch (err) {
      if (err instanceof RetryBuildingException) {
        await new Promise<void>((resolve) =>
          this.ctx.config.timeProvider.setImmediate(resolve)
        );
        block = this.buildBlock([draft]);
      } else {
        throw err;
      }
    }

    const fact = this.ctx.get(BlockService).create(
      block,
      (fact) => {
        if (fact.type !== FactType.Block) {
          throw new Error(`Invalid fact type!`);
        }
        // TODO: We need to enable this in a way that doesn't block the GC of inputs/refs
        // WeakRef?
        // fact.persistentSources.push(draft);
      },
    );
    if (draft.onBlock !== undefined) {
      // TODO: Make the groupIdx more robust; it shouldn't depend on the internals of buildBlock
      draft.onBlock(fact, 0);
    }
  }

  // timeout ??= defaultTimeout;
  // if (timeout < 0) {
  //   throw new Error(`Block publish timeout cannot be negative!`);
  // }

  // this.pubsPerMs++;

  // if (this.drafts.length === 0) {
  //   if (timeout === 0) {
  //     return this.ctx.get(BlockService).create(this.buildBlock([draft]));
  //   } else {
  //     this.drafts.push(draft);
  //     this.emitAt = this.ctx.config.timeProvider.now() + timeout;
  //     this.emitTimeout = this.ctx.config.timeProvider
  //       .setTimeout(this.doEmit, timeout);
  //     if (this.resolvers.length !== 0) {
  //       throw new Error(
  //         `Resolvers should be empty if building block isn't set!`,
  //       );
  //     }
  //     return new Promise((resolve) => this.resolvers.push(resolve));
  //   }
  // }

  // const existingFrontierLevel = this.drafts
  //   .find((d) => d.frontierLevel !== undefined)?.frontierLevel;
  // const mergeable = (existingFrontierLevel === undefined ||
  //   draft.frontierLevel === undefined ||
  //   existingFrontierLevel === draft.frontierLevel) &&
  //   this.ctx.get(FrontierChainService).getVote(
  //       [...this.drafts, draft].flatMap((d) => [
  //         ...d.inputs ?? [],
  //         ...d.refs?.map((ref) => ({ block: ref })) ?? [],
  //       ]),
  //     ) !== undefined;

  // // if (
  // //   mergeable && spec.frontierVote !== undefined &&
  // //   bb.frontierVote !== undefined
  // // ) {
  // //   const mergedVote = this.ctx.get(FrontierService2)
  // //     .mergeFrontierVotes(spec.frontierVote, bb.frontierVote);
  // //   if (mergedVote !== undefined) {
  // //     bb.frontierVote = mergedVote;
  // //   } else {
  // //     // Frontier votes are not mergeable
  // //     mergeable = false;
  // //   }
  // // }

  // if (mergeable) {
  //   this.drafts.push(draft);

  //   if (timeout === 0) {
  //     // Mergeable and we need to emit immediately:
  //     // Merge and emit; clear building block.
  //     this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
  //     const drafts = this.drafts;
  //     this.drafts = [];
  //     const resolvers = this.resolvers;
  //     this.resolvers = [];
  //     const fact = this.ctx.get(BlockService).create(this.buildBlock(drafts));
  //     resolvers.forEach((fn) => fn(fact));
  //     return fact;
  //   } else {
  //     // Mergeable and we can wait to emit:
  //     // Merge and re-schedule the emit if we're reducing it.
  //     const emitAt = this.ctx.config.timeProvider.now() + timeout;
  //     if (emitAt < this.emitAt) {
  //       this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
  //       this.emitAt = emitAt;
  //       this.emitTimeout = this.ctx.config.timeProvider
  //         .setTimeout(this.doEmit, timeout);
  //     }
  //     return new Promise((resolve) => this.resolvers.push(resolve));
  //   }
  // } else {
  //   if (timeout === 0) {
  //     // Not mergeable and we need to emit immediately:
  //     // Just emit the current block now and leave the other one to emit later.
  //     return this.ctx.get(BlockService).create(this.buildBlock([draft]));
  //   } else {
  //     // Not mergeable and we can wait to emit:
  //     // Emit the block that should be emitted first; leave the other one for later.
  //     const emitAt = this.ctx.config.timeProvider.now() + timeout;
  //     if (emitAt < this.emitAt) {
  //       // Emit the current block now and leave the building one for later.
  //       return this.ctx.get(BlockService).create(this.buildBlock([draft]));
  //     } else {
  //       // Emit the building block now and leave the current one for later.
  //       this.ctx.config.timeProvider.clearTimeout(this.emitTimeout);
  //       const drafts = this.drafts;
  //       this.drafts = [draft];
  //       this.emitAt = emitAt;
  //       this.emitTimeout = this.ctx.config.timeProvider
  //         .setTimeout(this.doEmit, timeout);
  //       const bbResolvers = this.resolvers;
  //       return new Promise((resolve) => {
  //         this.resolvers = [resolve];
  //         const fact = this.ctx.get(BlockService)
  //           .create(this.buildBlock(drafts));
  //         bbResolvers.forEach((fn) => fn(fact));
  //       });
  //     }
  //   }
  // }
}
