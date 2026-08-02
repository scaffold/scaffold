import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractProvider } from '.././ContractProvider.ts';
import { Block, Draft, Predicate } from '../../graph/types.ts';
import { GenerationEnv } from './GenerationEnv.ts';
import { VerificationEnv } from './VerificationEnv.ts';
import { Contract } from './Contract.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { WalkerHost } from '../values.ts';
import { Hash } from '../../util/Hash.ts';
import { Reader } from '../Reader.ts';

export class EnvContractProvider implements ContractProvider {
  constructor(private ctx: Context, private contract: Contract) {}

  async generate(
    predicate: Predicate,
    draft: Draft,
    flowCtl: FlowCtl,
  ) {
    const env = new GenerationEnv(this.ctx, predicate, draft, flowCtl);
    await this.contract.run(env, flowCtl);
    env.finalize();
  }

  async verify(
    predicate: Predicate,
    block: Block,
    flowCtl: FlowCtl,
  ) {
    const env = new VerificationEnv(this.ctx, predicate, block, flowCtl);
    await this.contract.run(env, flowCtl);
    env.finalize();
  }

  buildParams(
    contract: Hash,
    reader: (descriptor: string) => MaybePromise<Reader>,
  ): MaybePromise<Uint8Array> {
    if (this.contract.buildParams === undefined) {
      throw new Error(`buildParams is not supplied for contract ${contract.toHex()}`);
    }
    return this.contract.buildParams(reader);
  }

  buildData(
    contract: Hash,
    reader: (descriptor: string) => MaybePromise<Reader>,
  ): MaybePromise<Uint8Array> {
    if (this.contract.buildData === undefined) {
      throw new Error(`buildData is not supplied for contract ${contract.toHex()}`);
    }
    return this.contract.buildData(reader);
  }

  walkParams(
    contract: Hash,
    params: Uint8Array,
    host: WalkerHost,
  ): MaybePromise<void> {
    if (this.contract.walkParams === undefined) {
      throw new Error(`walkParams is not supplied for contract ${contract.toHex()}`);
    }
    return this.contract.walkParams(params, host);
  }

  walkData(
    contract: Hash,
    data: Uint8Array,
    host: WalkerHost,
  ): MaybePromise<void> {
    if (this.contract.walkData === undefined) {
      throw new Error(`walkData is not supplied for contract ${contract.toHex()}`);
    }
    return this.contract.walkData(data, host);
  }

  debugName?(predicate: Predicate): string | undefined {
    return this.contract.debug?.(predicate.params, this.ctx);
  }
}
