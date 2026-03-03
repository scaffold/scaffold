import { BlockBuilder, BlockDraft, InputSpec, OutputSpec } from './BlockBuilder.ts';
import {
  DataTreeNode,
  ImmutableTreeNode,
  MutableDataTreeNode,
  MutableTreeNode,
} from './DataTreeOverlay.ts';
import {
  BurdenOfProof,
  ComputationDriver,
  ComputationType,
  InputSource,
} from './ComputationMeta.ts';
import { Context } from './Context.ts';
import { BlockFact, FactType } from './FactMeta.ts';
import { KeyService } from './KeyService.ts';
import { Verifier } from './messages.ts';
import { DataTree } from './protocol/base.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { WorkerDriver } from './WorkerDriver.ts';
import { digestTree, TreeObj } from './DataTreeHelper.ts';
import { FactService } from './FactService.ts';
import { todo } from './util/functional.ts';
import { AvailableOutputManager } from './AvailableOutputManager.ts';
import { MergeabilityService } from './MergeabilityService.ts';
import { ClockService } from './ClockService.ts';
import { Logger } from './Logger.ts';
import { LogSystem } from './Config.ts';

export const GENERATION_SUCCESS_FLAG = Symbol('GenerationService.Success');
class GenerationException extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

const attemptDupeFraction = Hash.fromFraction(0, 8);

export class GenerationDriver extends WorkerDriver implements ComputationDriver {
  type = ComputationType.Generator;

  contractHash: Hash;
  params: ImmutableTreeNode;
  body: MutableDataTreeNode;

  // Make these super-private so js generators can't see them

  private shouldEmitCorrect: boolean;

  private fulfillsVerifiers: Verifier[];
  private inputs: InputSpec[] = [];
  private inputsAreFixed = false;
  private refs: BlockFact[] = [];
  // private satisfies:Verifier=[];
  private outputs: OutputSpec[] = [];
  // private frontierLevel: number | undefined;
  private timestampGte: number | undefined;

  private claimWeightBoost = 0n;

  #log?: Logger;

  constructor(ctx: Context, verifier: Verifier, scoreFn: () => number) {
    super(ctx, scoreFn);

    this.contractHash = verifier.contractHash;
    this.params = new DataTreeNode(verifier.params);

    this.body = new MutableDataTreeNode();

    this.shouldEmitCorrect = Hash.compare(
      Hash.digest(arrConcat(
        ctx.config.entropyProvider.cryptoRandomBytes(32),
        verifier.contractHash.toBytes(),
        digestTree(verifier.params).toBytes(),
      )),
      attemptDupeFraction,
    ) === 1;

    this.fulfillsVerifiers = [verifier];

    this.#log = Logger.create(ctx, LogSystem.Generation);
  }

  emitHint(idx: number, hint: TreeObj): void {
    this.#log?.info(`emitHint`, { idx, hint });
    throw new Error('Method not implemented.');
  }

  getHint(idx: number, bop: BurdenOfProof): ImmutableTreeNode {
    this.#log?.info(`getHint`, { idx, bop });
    throw new Error(`Cannot call getHint() inside a generator!`);
  }

  requireOutput(output: OutputSpec): void {
    this.#log?.info(`requireOutput`, { output });
    if (this.getDoneSignal().aborted) {
      return;
    }
    this.outputs.push(output);
  }

  requireTimestampGte(timestamp: number): MaybePromise<void> {
    this.#log?.info(`requireTimestampGte`, { timestamp });
    const wait = timestamp - this.ctx.config.timeProvider.now();
    if (wait > 0) {
      return new Promise<void>((resolve) => this.ctx.get(ClockService).setTimeout(resolve, wait));
    }

    // if (this.timestampGte === undefined || timestamp > this.timestampGte) {
    //   this.timestampGte = timestamp;
    // }
  }

  isSignedBy(publicKey: Uint8Array): boolean {
    this.#log?.info(`isSignedBy`, { publicKey });
    return arrEquals(publicKey, this.ctx.get(KeyService).getSelfPublicKey());
  }

  requireSignature(publicKey: Uint8Array): void {
    this.#log?.info(`requireSignature`, { publicKey });
    // TODO: If we don't call this, maybe we don't necessarily need to sign the block?
    const selfPublicKey = this.ctx.get(KeyService).getSelfPublicKey();
    if (!arrEquals(publicKey, selfPublicKey)) {
      this.ingenerable(`requireSignature() called with an unknown public key!`);
    }
  }

  emitCorrect(): boolean {
    this.#log?.info(`emitCorrect`);
    return this.shouldEmitCorrect;
  }

  lookup(hash: Hash): ImmutableTreeNode {
    this.#log?.info(`lookup`, { hash });
    const fact = this.ctx.get(FactService).get(hash, false);
    if (fact !== undefined && fact.type === FactType.Block) {
      return new DataTreeNode(fact.body);
    }
    todo();
  }
  fetch(contractHash: Hash, params: TreeObj): ImmutableTreeNode {
    this.#log?.info(`fetch`, { contractHash, params });
    throw new Error('Method not implemented.');
  }

  collectInputs(): MaybePromise<InputSource[]> {
    this.#log?.info(`collectInputs`);
    let inputsAreFixed = false;
    if (!inputsAreFixed) {
      for (const verifier of this.fulfillsVerifiers) {
        this.inputs = this.inputs.concat(
          this.ctx.get(AvailableOutputManager).popAll(verifier, (test) => this.isMergeable(test)),
        );
      }
      inputsAreFixed = true;
    }

    return this.inputs.map((input) => {
      const output = input.block.outputs[input.outputIdx];
      return {
        input,
        output,
        body: input.block.body,
        timestamp: input.block.timestamp,
      };
    });
  }

  requireInput(satisfies?: Verifier, outputsTo?: Verifier): MaybePromise<InputSource> {
    this.#log?.info(`requireInput`, { satisfies, outputsTo });
    throw new Error('Method not implemented.');
  }
  compareBlockOrder(hashA: Hash, hashB: Hash): number {
    this.#log?.info(`compareBlockOrder`, { hashA, hashB });
    throw new Error('Method not implemented.');
  }
  pass(): never {
    this.#log?.info(`pass`);
    throw new Error('Method not implemented.');
  }
  fail(msg?: string): never {
    this.#log?.info(`fail`, { msg });
    throw new Error('Method not implemented.');
  }
  boostClaimWeight(offset: bigint): void {
    this.#log?.info(`boostClaimWeight`, { offset });
    this.claimWeightBoost += offset;
  }
  ingenerable(msg?: string): void {
    this.#log?.info(`ingenerable`, { msg });
    throw new GenerationException(msg ?? `ingenerable() called!`);
  }

  override async finish(err?: typeof GENERATION_SUCCESS_FLAG | Error): Promise<void> {
    this.#log?.info(`finish`, { err });
    if (err === GENERATION_SUCCESS_FLAG) {
      err = undefined;
    }

    if (err === undefined) {
      this.collectInputs();
      const draft: BlockDraft = {
        body: this.body.toDataTree(),
        inputs: this.inputs,
        outputs: this.outputs,
        refs: this.refs,
        claimWeightBoost: this.claimWeightBoost,
      };

      this.ctx.get(BlockBuilder).publishSingleDraft(draft);
    }

    super.finish(err);
  }

  getResult() {
    this.#log?.info(`getResult`);
    return this.body.toDataTree();
  }

  private isMergeable(testInput: { block: BlockFact; outputIdx?: number }) {
    // if (
    //   false &&
    //   outputIdx !== undefined && verifierInputs.length > 0 &&
    //   Hash.equals(state.verifierState.verifier.contractHash, frontierHash)
    // ) {
    //   const frontierCount = verifierInputs.filter((x) =>
    //     x.outputIdx === x.block.frontierOutputIdx
    //   ).length;
    //   if (frontierCount > frontierInputCount) {
    //     throw new Error(`Internal error!`);
    //   } else if (frontierCount === frontierInputCount) {
    //     return false;
    //   }

    //   const lastBlock = verifierInputs[verifierInputs.length - 1].block;
    //   return block.frontierVoteBlock !== undefined &&
    //     (block.frontierVoteBlock === lastBlock ||
    //       (block.frontierVoteBlock === lastBlock.frontierVoteBlock &&
    //         this.isFrontierMergeable(block, lastBlock)));
    // }

    return testInput.block.isCanonical && this.ctx.get(MergeabilityService).isMergeable([
      ...this.inputs.map((x) => x.block),
      ...this.refs,
      testInput.block,
    ]);
  }
}
