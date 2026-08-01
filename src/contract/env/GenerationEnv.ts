import { Context } from '../../Context.ts';
import { DraftStore } from '../../graph/DraftStore.ts';
import { OutputIndex } from '../../graph/OutputIndex.ts';
import { Block, Draft, DRAFT_SELF, DraftPayload, Predicate } from '../../graph/types.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { ContractEnv, ExecutionMode } from './ContractEnv.ts';

export class GenerationEnv implements ContractEnv {
  private claims: { producer: Block | typeof DRAFT_SELF; outputIndex: number }[] = [];
  private result?: Uint8Array;

  constructor(
    private ctx: Context,
    private predicate: Predicate,
    private draft: Draft,
    private flowCtl: FlowCtl,
  ) {}

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

          resolve(output.output.data);
        }
      }, controller.signal);
    });
  }

  setResult(result: Uint8Array) {
    this.result = result;
    this.updateDraft();
  }

  private updateDraft() {
    const payload: DraftPayload = { claims: [...this.claims], refs: [], outputs: [] };

    if (this.result !== undefined) {
      payload.claims.push({ producer: DRAFT_SELF, outputIndex: 0 });
      payload.outputs.push({
        contract: this.predicate.contract,
        params: this.predicate.params,
        data: this.result,
        amount: 0n,
      });
    }

    this.ctx.get(DraftStore).update(this.draft, payload);
  }
}
