import { OutputSpec } from './BlockBuilder.ts';
import { TreeObj } from './BytesTreeHelper.ts';
import {
  BytesTreeNode,
  MutableBytesTreeNode,
  MutableTreeNode,
  TreeNode,
} from './BytesTreeOverlay.ts';
import {
  BurdenOfProof,
  ComputationDriver,
  ComputationType,
  InputSource,
} from './ComputationMeta.ts';
import { Context } from './Context.ts';
import { KeyService } from './KeyService.ts';
import { Verifier } from './messages.ts';
import { BytesTree } from './protocol/base.ts';
import { arrEquals } from './util/buffer.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { WorkerDriver } from './WorkerDriver.ts';

export const GENERATION_SUCCESS_FLAG = Symbol('GenerationService.Success');
class GenerationException extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export class GenerationDriver extends WorkerDriver implements ComputationDriver {
  type = ComputationType.Generator;

  contractHash: Hash;
  params: TreeNode;
  body: MutableTreeNode;

  #emitCorrect: boolean | undefined;

  #body: Uint8Array | undefined;
  #fulfillsVerifiers = [verifier];
  #inputs: InputSpec[] = [];
  #inputsAreFixed = false;
  #refs: BlockFact[] = [];
  // #satisfies:Verifier=[];
  #outputs: OutputSpec[] = [];
  // #frontierLevel: number | undefined;
  #timestampGte: bigint | undefined;

  constructor(ctx: Context, verifier: Verifier, scoreFn: () => number) {
    super(ctx, scoreFn);

    this.contractHash = verifier.contractHash;
    this.params = new BytesTreeNode(verifier.params);
    this.body = new MutableBytesTreeNode();
  }

  getHint(idx: number, bop: BurdenOfProof): TreeNode {
    throw new Error(`Cannot call getHint() inside a generator!`);
  }

  requireOutput(output: OutputSpec): void {
    if (this.getDoneSignal().aborted) {
      return;
    }
    this.#outputs.push(output);
  }

  requireTimestampGte(timestamp: bigint): MaybePromise<void> {
    if (this.#timestampGte === undefined || timestamp > this.#timestampGte) {
      this.#timestampGte = timestamp;
    }
  }

  isSignedBy(publicKey: Uint8Array): boolean {
    return arrEquals(publicKey, this.ctx.get(KeyService).getSelfPublicKey());
  }

  requireSignature(publicKey: Uint8Array): void {
    // TODO: If we don't call this, maybe we don't necessarily need to sign the block?
    const selfPublicKey = this.ctx.get(KeyService).getSelfPublicKey();
    if (!arrEquals(publicKey, selfPublicKey)) {
      throw new GenerationException(
        `requireSignature(...) called with an unknown public key!`,
      );
    }
  }

  emitCorrect(): boolean {
    throw new Error('Method not implemented.');
  }
  fetch(contractHash: Hash, params: BytesTree): TreeNode {
    throw new Error('Method not implemented.');
  }
  collectInputs(): MaybePromise<InputSource[]> {
    throw new Error('Method not implemented.');
  }
  requireInput(satisfies?: Verifier, outputsTo?: Verifier): MaybePromise<InputSource> {
    throw new Error('Method not implemented.');
  }
  compareBlockOrder(hashA: Hash, hashB: Hash): number {
    throw new Error('Method not implemented.');
  }
  pass(): never {
    throw new Error('Method not implemented.');
  }
  fail(msg?: string): never {
    throw new Error('Method not implemented.');
  }
  offsetCanonicality(offset: bigint): void {
    throw new Error('Method not implemented.');
  }
  ingenerable(msg?: string): void {
    throw new Error('Method not implemented.');
  }

  override finish(err?: typeof GENERATION_SUCCESS_FLAG | Error): MaybePromise<void> {
    super.finish(err);
  }
}
