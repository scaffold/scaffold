import { Context } from '../../Context.ts';
import { DraftStore } from '../../graph/DraftStore.ts';
import { Draft, DRAFT_SELF, Predicate } from '../../graph/types.ts';
import { ContractEnv, ExecutionMode } from './ContractEnv.ts';

export class GenerationEnv implements ContractEnv {
  constructor(
    private ctx: Context,
    private predicate: Predicate,
    private draft: Draft,
    private signal: AbortSignal,
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
    return new Promise<Uint8Array>(() => {});
  }

  setResult(result: Uint8Array) {
    this.ctx.get(DraftStore).update(this.draft, {
      claims: [{ producer: DRAFT_SELF, outputIndex: 0n }],
      refs: [],
      outputs: [{
        contract: this.predicate.contract,
        params: this.predicate.params,
        data: result,
        amount: 0n,
      }],
    });
  }
}
