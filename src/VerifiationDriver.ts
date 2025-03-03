import { InputSpec, OutputSpec } from './BlockBuilder.ts';
import {
  DataTreeNode,
  ImmutableTreeNode,
  MutableDataTreeNode,
  MutableTreeNode,
} from './DataTreeOverlay.ts';
import { CollateralHint } from './collateralMessages.ts';
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
import { encodeDataTree, TreeObj } from './DataTreeHelper.ts';
import { assert } from '@std/assert/assert';

export const VERIFICATION_SUCCESS_FLAG = Symbol('VerificationService.Success');
class VerificationException extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export class VerificationDriver extends WorkerDriver implements ComputationDriver {
  type = ComputationType.Contract;

  contractHash: Hash;
  params: ImmutableTreeNode;
  body: MutableTreeNode;

  // Make these super-private so js generators can't see them

  #block: BlockFact;

  #groupIdx: number;

  #readHints: DataTree[];

  #nextInputIdx = 0;
  #nextOutputIdx = 0;

  #claimWeightBoost = 0n;

  constructor(
    ctx: Context,
    block: BlockFact,
    verifier: Verifier,
    hintPrefix: DataTree[],
    scoreFn: () => number,
  ) {
    super(ctx, scoreFn);

    this.contractHash = verifier.contractHash;
    this.params = new DataTreeNode(verifier.params);
    this.body = new MutableDataTreeNode();

    this.#block = block;

    const rootHint = CollateralHint.decode(hintPrefix[0].value!.bytes).hint;
    if (!('CollateralHintVerifier' in rootHint)) {
      throw new Error(`Invalid root hint ${JSON.stringify(rootHint)}`);
    }
    this.#groupIdx = rootHint.CollateralHintVerifier.groupIdx;

    this.#readHints = hintPrefix.slice(0, 1);
  }

  emitHint(idx: number, hint: TreeObj): void {
    throw new Error('Method not implemented.');
  }

  getHint(idx: number, bop: BurdenOfProof): ImmutableTreeNode {
    throw new Error('Method not implemented.');
  }

  requireOutput(output: OutputSpec): void {
    throw new Error('Method not implemented.');
  }

  requireTimestampGte(timestamp: bigint): MaybePromise<void> {
    throw new Error('Method not implemented.');
  }

  isSignedBy(publicKeyHash: Hash): boolean {
    throw new Error('Method not implemented.');
  }

  requireSignature(publicKeyHash: Hash): void {
    throw new Error('Method not implemented.');
  }

  emitCorrect(): boolean {
    return true;
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
  boostClaimWeight(offset: bigint): void {
    this.#claimWeightBoost += offset;
  }
  ingenerable(msg?: string): void {
    throw new Error('Method not implemented.');
  }

  override finish(err?: typeof VERIFICATION_SUCCESS_FLAG | Error): MaybePromise<void> {
    if (err === VERIFICATION_SUCCESS_FLAG) {
      err = undefined;
    }

    assert(this.#block.claimWeightBoost === this.#claimWeightBoost);

    super.finish(err);
  }

  getResult() {
    return encodeDataTree(true);
  }
}
