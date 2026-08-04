import { assert, todo } from '../../util/functional.ts';
import { Context } from '../../Context.ts';
import { DraftStore } from '../../graph/DraftStore.ts';
import { OutputIndex } from '../../graph/OutputIndex.ts';
import {
  Block,
  Draft,
  DRAFT_SELF,
  DraftPayload,
  OutputResolverType,
  Predicate,
} from '../../graph/types.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { ContractEnv, ExecutionMode } from './ContractEnv.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';

export class GenerationEnv implements ContractEnv {
  private claims: { producer: Block | typeof DRAFT_SELF; outputIndex: number }[] = [];
  private result?: Uint8Array;

  constructor(
    private ctx: Context,
    private predicate: Predicate,
    private draft: Draft,
    private flowCtl: FlowCtl,
  ) {
    this.updateDraft();
  }

  mode() {
    return ExecutionMode.Generation;
  }

  contractHash() {
    return this.predicate.contract;
  }

  params() {
    return this.predicate.params;
  }

  claim() {
    return new Promise<Uint8Array>((resolve) => {
      const controller = new AbortController();
      this.ctx.get(OutputIndex).onOutput(this.predicate, (output) => {
        if (output.output.data !== undefined && output.claims.length === 0) {
          controller.abort();

          this.claims.push(output);
          this.updateDraft();

          const newClaims = (output.producer.resolvingOutputs.get(BigInt(output.outputIndex)) ?? [])
            .filter((x) => x.type === OutputResolverType.Claim);
          assert(newClaims.length > 0);

          resolve(output.output.data);
        }
      }, controller.signal);
    });
  }

  getResult(): MaybePromise<Uint8Array> {
    return todo();
  }

  setResult(result: Uint8Array) {
    this.result = result;
    this.updateDraft();
  }

  finalize() {
    this.updateDraft();
  }

  private updateDraft() {
    const payload: DraftPayload = {
      claims: [...this.getAvailableIncentive(), ...this.claims],
      refs: [],
      outputs: [],
    };

    if (this.result !== undefined) {
      payload.claims.push({ producer: DRAFT_SELF, outputIndex: payload.outputs.length });
      payload.outputs.push({
        contract: this.predicate.contract,
        params: this.predicate.params,
        data: this.result,
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
        output.output.data === undefined &&
        output.claims.every((x) => x.claimer === this.draft)
      ) {
        claims.push(output);
      }
    }, controller.signal);
    controller.abort();

    return claims;
  }
}
