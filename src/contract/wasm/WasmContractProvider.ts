import { Context } from '../../Context.ts';
import { Hash, HashPrimitive } from '../../util/Hash.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { Block, Draft, Predicate } from '../../graph/types.ts';
import { ContractProvider, PutRequest } from '../ContractProvider.ts';
import { EnvContractProvider } from '../env/EnvContractProvider.ts';
import { SinkRoot, SourceRoot } from '../values.ts';
import { WasmContract } from './WasmContract.ts';
import { mapPut } from '../../util/map.ts';

// The routing base: any contract hash not statically registered is presumed
// to name a WASM manifest blob.
export class WasmContractProvider implements ContractProvider {
  private cache = new Map<HashPrimitive, EnvContractProvider>();

  constructor(private ctx: Context) {}

  generate(
    predicate: Predicate,
    put: PutRequest | undefined,
    draft: Draft,
    flowCtl: FlowCtl,
  ): MaybePromise<void> {
    return this.providerFor(predicate.contract).generate(predicate, put, draft, flowCtl);
  }

  verify(predicate: Predicate, block: Block, flowCtl: FlowCtl): MaybePromise<void> {
    return this.providerFor(predicate.contract).verify(predicate, block, flowCtl);
  }

  buildParams(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    return this.providerFor(contract).buildParams(contract, source);
  }

  buildData(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    return this.providerFor(contract).buildData(contract, source);
  }

  walkParams(contract: Hash, params: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    return this.providerFor(contract).walkParams(contract, params, sink);
  }

  walkData(contract: Hash, data: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    return this.providerFor(contract).walkData(contract, data, sink);
  }

  debug(predicate: Predicate): string | undefined {
    return this.providerFor(predicate.contract).debug?.(predicate);
  }

  private providerFor(contract: Hash): EnvContractProvider {
    return mapPut(
      this.cache,
      contract.toPrimitive(),
      () => new EnvContractProvider(this.ctx, new WasmContract(this.ctx, contract)),
    );
  }
}
