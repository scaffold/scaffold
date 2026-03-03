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
import { BlockFact, FactType } from './FactMeta.ts';
import { KeyService } from './KeyService.ts';
import { Verifier } from './messages.ts';
import { DataTree } from './protocol/base.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { WorkerDriver } from './WorkerDriver.ts';
import { encodeDataTree, TreeObj } from './DataTreeHelper.ts';
import { assert } from '@std/assert/assert';
import { todo } from './util/functional.ts';
import { FactService } from './FactService.ts';
import { Logger } from './Logger.ts';
import { LogSystem } from './Config.ts';

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

  private block: BlockFact;

  private groupIdx: number;

  private readHints: DataTree[];

  private nextInputIdx = 0;
  private nextOutputIdx = 0;

  private claimWeightBoost = 0n;

  #log?: Logger;

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
    this.body = new MutableDataTreeNode(block.body);

    this.block = block;

    const rootHint = CollateralHint.decode(hintPrefix[0].value!.bytes).hint;
    if (!('CollateralHintVerifier' in rootHint)) {
      throw new Error(`Invalid root hint ${JSON.stringify(rootHint)}`);
    }
    this.groupIdx = rootHint.CollateralHintVerifier.groupIdx;

    this.readHints = hintPrefix.slice(0, 1);

    this.#log = Logger.create(ctx, LogSystem.Verification);
  }

  emitHint(idx: number, hint: TreeObj): void {
    this.#log?.info(`emitHint`, { idx, hint });
    throw new Error('Method not implemented.');
  }

  getHint(idx: number, bop: BurdenOfProof): ImmutableTreeNode {
    this.#log?.info(`getHint`, { idx, bop });
    throw new Error('Method not implemented.');
  }

  requireOutput(output: OutputSpec): void {
    this.#log?.info(`requireOutput`, { output });
    throw new Error('Method not implemented.');
  }

  requireTimestampGte(timestamp: number): MaybePromise<void> {
    this.#log?.info(`requireTimestampGte`, { timestamp });
    if (this.block.timestamp < timestamp) {
      throw new VerificationException(
        `requireTimestampGte(...) failed - the block's timestamp is less than the contract's specification!`,
      );
    }
  }

  isSignedBy(publicKey: Uint8Array): boolean {
    this.#log?.info(`isSignedBy`, { publicKey });
    return this.ctx.get(FactService).verify(this.block, publicKey);
  }

  requireSignature(publicKey: Uint8Array): void {
    this.#log?.info(`requireSignature`, { publicKey });
    if (!this.ctx.get(FactService).verify(this.block, publicKey)) {
      throw new VerificationException(
        `requireSignature(...) failed - the block's signature does not match the contract's specification!`,
      );
    }
  }

  emitCorrect(): boolean {
    this.#log?.info(`emitCorrect`);
    return true;
  }

  lookup(hash: Hash): ImmutableTreeNode {
    this.#log?.info(`lookup`, { hash });
    // TODO: Check that the hash is present in the refs array
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
    throw new Error('Method not implemented.');
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
    throw new Error('Method not implemented.');
  }

  override finish(err?: typeof VERIFICATION_SUCCESS_FLAG | Error): MaybePromise<void> {
    this.#log?.info(`finish`, { err });
    if (err === VERIFICATION_SUCCESS_FLAG) {
      err = undefined;
    }

    assert(this.block.claimWeightBoost === this.claimWeightBoost);

    super.finish(err);
  }

  getResult() {
    this.#log?.info(`getResult`);
    return encodeDataTree(true);
  }
}
