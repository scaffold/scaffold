import { assert, todo } from '../../util/functional.ts';
import { Context } from '../../Context.ts';
import { DraftStore } from '../../graph/DraftStore.ts';
import { OutputIndex } from '../../graph/OutputIndex.ts';
import {
  Block,
  Draft,
  DRAFT_SELF,
  DraftPayload,
  Output,
  OutputResolverType,
  Predicate,
} from '../../graph/types.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { ClaimResult, ContractEnv, ExecutionMode, PutOptions } from './ContractEnv.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { PutRequest } from '../ContractProvider.ts';
import { arrEquals } from '../../util/buffer.ts';
import { Hash } from '../../util/Hash.ts';
import { secp } from '../../util/secp.ts';
import { EXACT_BLOCK_CONTRACT } from '../static/ExactBlock.ts';

export class GenerationEnv implements ContractEnv {
  private readParamsBytes = 0;
  private claims: { producer: Block | typeof DRAFT_SELF; outputIndex: number }[] = [];
  private outputs: Output[] = [];
  private result?: Uint8Array;
  private minTimestampMs = -Infinity;

  constructor(
    private ctx: Context,
    private predicate: Predicate,
    put: PutRequest | undefined,
    private draft: Draft,
    private flowCtl: FlowCtl,
  ) {
    if (put !== undefined) {
      this.result = put.body;
    }
    this.updateDraft();
  }

  mode() {
    return ExecutionMode.Generation;
  }

  blockHash(): never {
    throw new Error('Ingenerable');
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
    if (this.result !== undefined) {
      return this.result;
    } else {
      throw new Error(`Ingenerable: No result provided`);
    }
  }

  setResult(result: Uint8Array) {
    if (this.result === undefined) {
      this.result = result;
      this.updateDraft();
    } else if (!arrEquals(this.result, result)) {
      throw new Error(`Result changed: ${this.result} -> ${result}`);
    }
  }

  claimOne(from?: Predicate, output?: Predicate): Promise<ClaimResult> {
    return new Promise<ClaimResult>((resolve) => {
      const controller = new AbortController();
      this.ctx.get(OutputIndex).onOutput(output ?? this.predicate, (location) => {
        if (location.output.body === undefined) return;
        if (location.claims.length !== 0) return;

        if (from !== undefined) {
          if (Hash.equals(from.contract, EXACT_BLOCK_CONTRACT)) {
            if (!Hash.equals(location.producer.hash, Hash.fromBytes(from.params))) return;
          } else {
            // TODO: Handle other predicates
            // We need to somehow wait for the claim to be resolved
          }
        }

        controller.abort();

        this.claims.push(location);
        this.updateDraft();

        const newClaims =
          (location.producer.resolvingOutputs.get(BigInt(location.outputIndex)) ?? [])
            .filter((x) => x.type === OutputResolverType.Claim);
        assert(newClaims.length > 0);

        resolve({
          fromBlockHash: location.producer.hash,
          body: location.output.body,
          amount: location.output.amount,
          blockTimestampMs: location.producer.payload.timestampMs,
        });
      }, controller.signal);
    });
  }

  claimAll(from?: Predicate, output?: Predicate): MaybePromise<ClaimResult[]> {
    const results: ClaimResult[] = [];

    const controller = new AbortController();
    this.ctx.get(OutputIndex).onOutput(output ?? this.predicate, (location) => {
      if (location.output.body === undefined) return;
      if (location.claims.length !== 0) return;

      if (from !== undefined) {
        if (Hash.equals(from.contract, EXACT_BLOCK_CONTRACT)) {
          if (!Hash.equals(location.producer.hash, Hash.fromBytes(from.params))) return;
        } else {
          // TODO: Handle other predicates
          // We need to somehow wait for the claim to be resolved
        }
      }

      this.claims.push(location);

      const newClaims = (location.producer.resolvingOutputs.get(BigInt(location.outputIndex)) ?? [])
        .filter((x) => x.type === OutputResolverType.Claim);
      assert(newClaims.length > 0);

      results.push({
        fromBlockHash: location.producer.hash,
        body: location.output.body,
        amount: location.output.amount,
        blockTimestampMs: location.producer.payload.timestampMs,
      });
    }, controller.signal);
    controller.abort();

    if (results.length > 0) this.updateDraft();

    return results;
  }

  fetch(_from: Predicate, _output?: Predicate): MaybePromise<Uint8Array> {
    return todo();
  }

  require(opts: PutOptions): void {
    return todo();
  }

  put(_opts: PutOptions): MaybePromise<Hash> {
    return todo();
  }

  send(to: Predicate, amount: bigint, body?: Uint8Array): void {
    this.outputs.push({ contract: to.contract, params: to.params, body, amount });
  }

  waitUntil(timestampMs: number): MaybePromise<void> {
    if (timestampMs > this.minTimestampMs) {
      this.minTimestampMs = timestampMs;

      const wait = timestampMs - this.ctx.config.timeProvider.nowMs();
      if (wait > 0) {
        return new Promise((resolve) => this.ctx.config.timeProvider.setTimeout(resolve, wait));
      }
    }
  }

  sign(publicKey: Uint8Array): void {
    // TODO: Make this a stronger assertion that the draft WILL be signed by the provided public key
    // Maybe capabilities?
    if (!arrEquals(publicKey, secp.getPublicKey(this.ctx.config.selfPrivateKey, true))) {
      throw new Error('ingenerable on this node');
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.ctx.logger('generation_env')?.debug(message, data);
  }

  finalize() {
    this.updateDraft();
  }

  private updateDraft() {
    const payload: DraftPayload = {
      claims: [...this.getAvailableIncentive(), ...this.claims],
      refs: [],
      outputs: [...this.outputs],
      minTimestampMs: this.minTimestampMs,
    };

    if (this.result !== undefined) {
      payload.claims.push({ producer: DRAFT_SELF, outputIndex: payload.outputs.length });
      payload.outputs.push({
        contract: this.predicate.contract,
        params: this.predicate.params,
        body: this.result,
        amount: 0n,
      });
    }

    this.ctx.get(DraftStore).update(this.draft, payload);
  }

  private getAvailableIncentive() {
    const claims: { producer: Block; outputIndex: number }[] = [];

    const controller = new AbortController();
    this.ctx.get(OutputIndex).onOutput(this.predicate, (output) => {
      if (
        output.output.body === undefined &&
        output.claims.every((x) => x.claimer === this.draft)
      ) {
        claims.push(output);
      }
    }, controller.signal);
    controller.abort();

    return claims;
  }
}
