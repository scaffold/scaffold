import { Context } from '../Context.ts';
import { arrEquals } from '../util/buffer.ts';
import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { ContractProvider } from './Contract.ts';
import { Block, DRAFT_SELF, DraftPayload, Output, Predicate } from './types.ts';

export enum ExecutionMode {
  Generation = 0,
  Verification = 1,
}

export interface ContractEnv {
  mode(): ExecutionMode;

  contractHash(): Hash;
  params(): Uint8Array;

  setResult(result: Uint8Array): void;
}

export interface Contract {
  run(env: ContractEnv, signal: AbortSignal): MaybePromise<void>;
}

export class EnvContractProvider implements ContractProvider {
  constructor(ctx: Context, private contract: Contract) {}

  generate(
    predicate: Predicate,
    update: (draftPayload: DraftPayload) => void,
    signal: AbortSignal,
  ): MaybePromise<void> {
    return this.contract.run({
      mode: () => ExecutionMode.Generation,
      contractHash: () => predicate.contract,
      params: () => predicate.params,
      setResult: (result) =>
        update({
          claims: [{ producer: DRAFT_SELF, outputIndex: 0n }],
          refs: [],
          outputs: [{
            contract: predicate.contract,
            params: predicate.params,
            data: result,
            amount: 0n,
          }],
        }),
    }, signal);
  }

  verify(
    predicate: Predicate,
    block: Block,
    signal: AbortSignal,
  ): MaybePromise<void> {
    return this.contract.run({
      mode: () => ExecutionMode.Generation,
      contractHash: () => predicate.contract,
      params: () => predicate.params,
      setResult: (result) => {
        const resultOutputs: Output[] = [];
        for (const claim of block.payload.claims) {
          if (claim >= BigInt(block.payload.outputs.length)) continue;
          const output = block.payload.outputs[Number(claim)];
          if (!Hash.equals(output.contract, predicate.contract)) continue;
          if (!arrEquals(output.params, predicate.params)) continue;
          if (output.data === undefined) continue;
          resultOutputs.push(output);
        }

        if (resultOutputs.length !== 1) {
          throw new Error(`Contract verification failed: Not exactly one result output`);
        }

        if (!arrEquals(resultOutputs[0].data!, result)) {
          throw new Error(`Contract verification failed: Result output data does not match`);
        }
      },
    }, signal);
  }
}
