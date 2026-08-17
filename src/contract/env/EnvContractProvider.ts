import { Context } from '../../Context.ts';
import { MaybePromise, maybeThen } from '../../util/MaybePromise.ts';
import { ContractProvider, PutRequest } from '.././ContractProvider.ts';
import { Block, Draft, Predicate } from '../../graph/types.ts';
import { GenerationEnv } from './GenerationEnv.ts';
import { VerificationEnv, VerificationFailure } from './VerificationEnv.ts';
import { Contract } from './Contract.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { SinkRoot, SourceRoot, ValueType } from '../values.ts';
import { Hash } from '../../util/Hash.ts';

export class EnvContractProvider implements ContractProvider {
  constructor(private ctx: Context, private contract: Contract) {}

  async generate(
    predicate: Predicate,
    put: PutRequest | undefined,
    draft: Draft,
    flowCtl: FlowCtl,
  ) {
    const env = new GenerationEnv(this.ctx, predicate, put, draft, flowCtl);
    await this.contract.run(env, flowCtl);
    env.finalize();
  }

  async verify(predicate: Predicate, block: Block, flowCtl: FlowCtl) {
    try {
      const env = new VerificationEnv(this.ctx, predicate, block, flowCtl);
      await this.contract.run(env, flowCtl);
      env.finalize();
      return true;
    } catch (err) {
      if (err instanceof VerificationFailure) {
        return false;
      }
      throw err;
    }
  }

  buildParams(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    if (this.contract.buildParams === undefined) {
      return this.buildDefault(
        source,
        `buildParams is not supplied for contract ${contract.toHex()}`,
      );
    }
    return this.contract.buildParams(source);
  }

  buildBody(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    if (this.contract.buildBody === undefined) {
      return this.buildDefault(
        source,
        `buildBody is not supplied for contract ${contract.toHex()}`,
      );
    }
    return this.contract.buildBody(source);
  }

  walkParams(contract: Hash, params: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    if (this.contract.walkParams === undefined) {
      return this.walkDefault(
        params,
        sink,
        `walkParams is not supplied for contract ${contract.toHex()}`,
      );
    }
    return this.contract.walkParams(params, sink);
  }

  walkBody(contract: Hash, body: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    if (this.contract.walkBody === undefined) {
      return this.walkDefault(
        body,
        sink,
        `walkBody is not supplied for contract ${contract.toHex()}`,
      );
    }
    return this.contract.walkBody(body, sink);
  }

  debug?(predicate: Predicate): string | undefined {
    return this.contract.debug?.(predicate.params, this.ctx);
  }

  // TODO: We might not even want to implement default builders/walkers so the caller knows it doesn't exist.
  // They can easily do this themselves.
  private buildDefault(source: SourceRoot, error: string): MaybePromise<Uint8Array> {
    this.ctx.logger('env_contract_provider')?.info(error);

    return maybeThen(source(), (root) => {
      if (root.type === ValueType.Bytes) {
        return root.value;
      } else {
        throw new Error(`${error}, and default builder expected bytes, got ${root.type}`);
      }
    });
  }

  private walkDefault(body: Uint8Array, sink: SinkRoot, error: string): MaybePromise<void> {
    this.ctx.logger('env_contract_provider')?.info(error);
    sink().setBytes(body);
  }
}
