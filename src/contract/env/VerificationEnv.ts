import { Context } from '../../Context.ts';
import { Block, Output, Predicate } from '../../graph/types.ts';
import { arrEquals } from '../../util/buffer.ts';
import { todo } from '../../util/functional.ts';
import { Hash } from '../../util/Hash.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { ContractEnv, ExecutionMode } from './ContractEnv.ts';

export class VerificationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationFailure';
  }
}

export class VerificationEnv implements ContractEnv {
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

  params() {
    return this.predicate.params;
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

  claim() {
    return todo();
  }

  finalize() {}
}
