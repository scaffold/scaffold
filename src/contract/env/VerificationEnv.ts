import { Context } from '../../Context.ts';
import { Block, Output, Predicate } from '../../graph/types.ts';
import { arrEquals } from '../../util/buffer.ts';
import { todo } from '../../util/functional.ts';
import { Hash } from '../../util/Hash.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { ClaimResult, ContractEnv, ExecutionMode, PutOptions } from './ContractEnv.ts';

export class VerificationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationFailure';
  }
}

export class VerificationEnv implements ContractEnv {
  private readParamsBytes = 0;

  constructor(
    private ctx: Context,
    private predicate: Predicate,
    private block: Block,
    private flowCtl: FlowCtl,
  ) {}

  mode() {
    return ExecutionMode.Verification;
  }

  blockHash(): Hash {
    return this.block.hash;
  }

  contractHash() {
    return this.predicate.contract;
  }

  params(truncate?: number) {
    if (truncate !== undefined && truncate > this.readParamsBytes) {
      this.readParamsBytes = truncate;
    }
    return this.predicate.params.subarray(0, truncate);
  }

  getResult() {
    return todo();
  }

  setResult(result: Uint8Array) {
    const resultOutputs: Output[] = [];
    for (const claim of this.block.payload.claims) {
      if (claim >= BigInt(this.block.payload.outputs.length)) continue;
      const output = this.block.payload.outputs[Number(claim)];
      if (!Hash.equals(output.contract, this.predicate.contract)) continue;
      if (!arrEquals(output.params, this.predicate.params)) continue;
      if (output.data === undefined) continue;
      resultOutputs.push(output);
    }

    if (resultOutputs.length !== 1) {
      throw new Error(`Contract verification failed: Not exactly one result output`);
    }

    if (!arrEquals(resultOutputs[0].data!, result)) {
      throw new Error(`Contract verification failed: Result output data does not match`);
    }
  }

  claimOne(_from?: Predicate, _output?: Predicate): MaybePromise<ClaimResult> {
    return todo();
  }

  claimAll(_from?: Predicate, _output?: Predicate): MaybePromise<ClaimResult[]> {
    return todo();
  }

  fetch(_from: Predicate, _output?: Predicate): MaybePromise<Uint8Array> {
    return todo();
  }

  require(_opts: PutOptions): void {
    return todo();
  }

  put(_opts: PutOptions): MaybePromise<Hash> {
    return todo();
  }

  send(_to: Predicate, _amount: bigint): void {
    return todo();
  }

  waitUntil(timestampMs: number): void {
    if (this.block.payload.timestampMs < timestampMs) {
      throw new Error('Block is too early');
    }
  }

  sign(publicKey: Uint8Array): void {
    if (this.block.signer === undefined) {
      throw new Error('block is not signed');
    }
    if (!arrEquals(publicKey, this.block.signer)) {
      throw new Error('block signer does not match required public key');
    }
  }

  finalize() {}
}
