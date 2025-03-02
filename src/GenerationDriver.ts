import { InputSpec, OutputSpec } from './BlockBuilder.ts';
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
import { BlockFact } from './FactMeta.ts';
import { KeyService } from './KeyService.ts';
import { Verifier } from './messages.ts';
import { DataTree } from './protocol/base.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { WorkerDriver } from './WorkerDriver.ts';
import { digestTree, TreeObj } from './DataTreeHelper.ts';

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
  body: MutableTreeNode;

  // Make these super-private so js generators can't see them

  #emitCorrect: boolean;

  #body: MutableDataTreeNode;
  #fulfillsVerifiers: Verifier[];
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
    this.params = new DataTreeNode(verifier.params);

    this.#body = new MutableDataTreeNode();
    this.body = this.#body;

    this.#emitCorrect = Hash.compare(
      Hash.digest(arrConcat(
        ctx.config.entropyProvider.cryptoRandomBytes(32),
        verifier.contractHash.toBytes(),
        digestTree(verifier.params).toBytes(),
      )),
      attemptDupeFraction,
    ) === 1;

    this.#fulfillsVerifiers = [verifier];
  }

  emitHint(idx: number, hint: TreeObj): void {
    throw new Error('Method not implemented.');
  }

  getHint(idx: number, bop: BurdenOfProof): ImmutableTreeNode {
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

  isSignedBy(publicKeyHash: Hash): boolean {
    return Hash.equals(publicKeyHash, this.ctx.get(KeyService).getSelfPublicKeyHash());
  }

  requireSignature(publicKeyHash: Hash): void {
    // TODO: If we don't call this, maybe we don't necessarily need to sign the block?
    const selfPublicKey = this.ctx.get(KeyService).getSelfPublicKeyHash();
    if (!Hash.equals(publicKeyHash, selfPublicKey)) {
      throw new GenerationException(
        `requireSignature(...) called with an unknown public key!`,
      );
    }
  }

  emitCorrect(): boolean {
    return this.#emitCorrect;
  }

  lookup(hash: Hash): ImmutableTreeNode {
    throw new Error('Method not implemented.');
  }
  fetch(contractHash: Hash, params: TreeObj): ImmutableTreeNode {
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
    if (err === GENERATION_SUCCESS_FLAG) {
      err = undefined;
    }

    super.finish(err);
  }

  getResult() {
    return this.#body.toDataTree();
  }
}
