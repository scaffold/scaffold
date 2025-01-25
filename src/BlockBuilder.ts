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
import { BlockService } from './BlockService.ts';
import { accountHash, collateralHash, frontierHash } from './hashes.ts';
import { KeyService } from './KeyService.ts';
import { BlockFact, FactSource, FactType } from './FactMeta.ts';
import { arrEquals, EMPTY_ARR } from './util/buffer.ts';
import { WeightService } from './WeightService.ts';
import { assert, error, todo } from './util/functional.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { FrontierService } from './FrontierService.ts';
import { ClockService } from './ClockService.ts';
import { FrontierService3, VOLUME_INCLUDES_SELF } from './FrontierService3.ts';
import { MergeabilityService } from './MergeabilityService.ts';
import { AvailableOutputManager } from './AvailableOutputManager.ts';

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
  groupIdx?: number;
  squashOutputAmount?: bigint;
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

  public buildBlock(
    drafts: BlockDraft[],
    checkIoBalance = true,
  ): Block & { draftGroupIdxs: number[] } {
    // 1. Gather all satisfying (positive?) inputs that someone else could claim (which doesn't include signature satisfaction).
    // 2. For remaining output value, input to/from account balance (signature satisfaction).

    // const verifier_hash = Hash.digest(Verifier.encode(verifier));
    // const inputs = this.ctx.get(IncentiveRegistry).pop(verifier_hash)?.inputs ||
    //   [];

    // drafts.sort((a, b) =>
    //   Number(b.body !== undefined) - Number(a.body !== undefined)
    // );

    let squashOutputAmount = this.ctx.config.enableBlockThroughput ? 10n : 0n;
    const refBlocks: BlockFact[] = [];
    const inputs: (InputSpec & BlockInput)[] = [];
    const outputs: BlockOutput[] = [];
    const bodies: Uint8Array[] = [];

    const groupIdxArr = drafts.map((x) => x.groupIdx).filter((x) => x !== undefined);
    const takenGroupIdxs = new Set(groupIdxArr);
    if (groupIdxArr.length !== takenGroupIdxs.size) {
      throw new Error(`Duplicate group idxs specified!`);
    }

    let groupIdx = 0;
    // The first group index will be 1
    // This ensures only frontier tree children will have a group index of 0
    const nextGroupIdx = () => {
      do {
        groupIdx++;
      } while (takenGroupIdxs.has(groupIdx));
      return groupIdx;
    };

    const draftGroupIdxs: number[] = [];

    for (const draft of drafts) {
      const groupIdx = draft.groupIdx ?? nextGroupIdx();
      draftGroupIdxs.push(groupIdx);

      while (bodies.length <= groupIdx) {
        bodies.push(EMPTY_ARR);
      }
      bodies[groupIdx] = draft.body ?? EMPTY_ARR;

      if (draft.squashOutputAmount !== undefined) {
        squashOutputAmount += draft.squashOutputAmount;
      }

      if (draft.refs !== undefined) {
        for (const ref of draft.refs) {
          refBlocks.push(ref);
        }
      }

      if (draft.inputs !== undefined) {
        for (const input of draft.inputs) {
          inputs.push({
            ...input,
            blockHash: input.block.hash,
            groupIdx,
            utxoIdx: -1,
          });
        }
      }

      if (draft.satisfies !== undefined) {
        for (const satisfaction of draft.satisfies) {
          this.collectInputs(
            satisfaction,
            true,
            (input) =>
              this.ctx.get(WeightService).isCanonical(input.block) &&
              this.ctx.get(MergeabilityService).isMergeable([
                ...inputs.map((x) => x.block),
                ...refBlocks,
                input.block,
              ]),
            (input) =>
              inputs.push({
                ...input,
                blockHash: input.block.hash,
                groupIdx,
                utxoIdx: -1,
              }),
          );
        }
      }

      if (draft.outputs !== undefined) {
        for (const output of draft.outputs) {
          outputs.push({ ...output, groupIdx });
        }
      }
    }

    let ioDelta = 0n;

    const addFrontierOutput = false;
    if (addFrontierOutput) {
      ioDelta -= squashOutputAmount;
    }

    ioDelta += inputs.reduce((acc, cur) => acc + cur.amount, 0n);
    ioDelta -= outputs.reduce((acc, cur) => acc + cur.amount, 0n);

    if (!this.ctx.config.enableBlockThroughput) {
      if (squashOutputAmount !== 0n) {
        throw new Error(`Invalid frontier output amount!`);
      }
      if (inputs.some((x) => x.amount !== 0n)) {
        throw new Error(`Invalid input amount!`);
      }
      if (outputs.some((x) => x.amount !== 0n)) {
        throw new Error(`Invalid output amount!`);
      }
      if (ioDelta !== 0n) {
        throw new Error(`Invalid throughput!`);
      }
    }

    while (ioDelta < 0n || inputs.length === 0) {
      const input = this.ctx.get(AvailableOutputManager).pop(
        this.selfAccountVerifier,
        (accountInput) =>
          this.ctx.get(WeightService).isCanonical(accountInput.block) &&
          this.ctx.get(MergeabilityService).isMergeable([
            ...inputs.map((x) => x.block),
            ...refBlocks,
            accountInput.block,
          ]),
      );
      if (input === undefined) {
        if (checkIoBalance) {
          throw new RetryBuildingException('Insufficient coins');
        }
        break;
      }

      if (input.amount > 0n) {
        // TODO: Handle groups without any result
        inputs.push({
          ...input,
          blockHash: input.block.hash,
          groupIdx: nextGroupIdx(),
          utxoIdx: -1,
        });
        ioDelta += input.amount;
      }
    }

    if (ioDelta > 0n) {
      outputs.push({
        verifier: this.selfAccountVerifier,
        amount: ioDelta,
        detail: EMPTY_ARR,
        groupIdx: nextGroupIdx(),
      });
    }

    const refs = refBlocks.map((block) => block.hash);

    // frontierVoteBlock ??= this.ctx.get(FrontierChainService).getVote([
    //   ...inputs,
    //   ...refBlocks.map((ref) => ({ block: ref })),
    // ]);
    // if (frontierVoteBlock === undefined) {
    //   throw new Error(`Unmergeable inputs!`);
    // }

    const links = this.ctx.get(FrontierService3).create([
      ...inputs.map((x) => x.block),
      ...refBlocks,
    ], inputs.map((x) => ({ block: x.block, utxoIdxs: [x.outputIdx] })));
    const blockLinks = this.ctx.get(FrontierService).build(links);

    if (addFrontierOutput) {
      // const amount = BigInt(
      //   Math.round(10 * Math.pow(frontierInputCount * 0.75, level)),
      // );

      // TODO: Move all of this logic to FrontierContract
      // We'll have to make the tree weights NOT include the self weight
      outputs.push({
        verifier: {
          contractHash: frontierHash,
          params: FrontierTreeParams.encode({ level: -1 }),
        },
        amount: squashOutputAmount,
        detail: FrontierTreeDetail.encode({}),
        // detail: FrontierTreeDetail.encode({
        //   treeWeights: this.ctx.get(FrontierService2)
        //     .mergeTreeWeights(inputs, frontierVoteBlock),
        //   // input_tree_root: ZERO_HASH,
        //   // output_tree_root: ZERO_HASH,

        //   // input_count: 0,
        //   // output_count: 0,

        //   // block_count: 1,
        //   // claimed_work: this.computeWork(inputs, outputs),

        //   ...FrontierHelper.mergeTreeIo(
        //     inputs,
        //     frontierVoteBlock,
        //     (hash) =>
        //       this.ctx.get(BlockService).get(hash, false) ??
        //         error(`Unknown frontier child input!`),
        //   ),
        // }),
        groupIdx: 0,
      });
    }

    // const frontierOutputIdx = outputs.findIndex((x) =>
    //   Hash.equals(x.verifier.contractHash, frontierHash)
    // );
    // assert(frontierOutputIdx !== -1);
    // assert(outputs[frontierOutputIdx].groupIdx === 0);

    for (const input of inputs) {
      input.utxoIdx = this.ctx.get(FrontierService).getUtxoIdx(input.block, input.outputIdx, {
        parentBlock: links.parent,
        squashes: blockLinks.squashes,
        outputs,
        squashedUtxoIdxs: blockLinks.squashedUtxoIdxs,
      });
    }

    while (bodies.length <= groupIdx) {
      bodies.push(EMPTY_ARR);
    }

    let timestamp = BigInt(this.ctx.config.timeProvider.now());
    if (this.ctx.config.graphParameters.enforceTimestampMonotonicity) {
      if (links.parent !== undefined && links.parent !== ZERO_BLOCK) {
        const inputTs = links.parent.timestamp +
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

    return { ...blockLinks, refs, inputs, outputs, bodies, timestamp, draftGroupIdxs };
  }

  private collectInputs(
    satisfaction: Verifier & { detail?: Uint8Array },
    publishStub: boolean,
    testInput: (input: InputSpec) => boolean,
    addInput: (input: InputSpec) => void,
  ) {
    for (const { block, idx } of this.ctx.get(BlockService).getBlocksByOutput(satisfaction)) {
      if (
        block.outputClaims[idx].length === 0 &&
        block.outputs[idx].amount >= 0n &&
        testInput({ block, outputIdx: idx, amount: block.outputs[idx].amount })
      ) {
        addInput({ block, outputIdx: idx, amount: block.outputs[idx].amount });
        publishStub = false;
      }
    }

    if (publishStub) {
      // TODO: Create stubs via setting the utxoIdx property
      let published = false;
      this.publishSingleDraft({
        groupIdx: Hash.equals(satisfaction.contractHash, frontierHash) ? 0 : undefined,
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

    const block = this.buildBlock([draft]);
    const fact = this.ctx.get(BlockService).create(block);
    if (draft.onBlock !== undefined) {
      // TODO: Make the groupIdx more robust; it shouldn't depend on the internals of buildBlock
      draft.onBlock(
        fact,
        block.draftGroupIdxs[0] ?? error(`BlockBuilder.buildBlock did not set groupIdx!`),
      );
    }

    return fact;
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

    let block: Block & { draftGroupIdxs: number[] };
    try {
      block = this.buildBlock([draft]);
    } catch (err) {
      if (err instanceof RetryBuildingException) {
        await new Promise<void>((resolve) => this.ctx.get(ClockService).setTimeout(resolve, 10));
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
      draft.onBlock(
        fact,
        block.draftGroupIdxs[0] ?? error(`BlockBuilder.buildBlock did not set groupIdx!`),
      );
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
