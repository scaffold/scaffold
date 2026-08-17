import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractProvider, PutRequest } from '.././ContractProvider.ts';
import { Block, Draft, Predicate } from '../../graph/types.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { SinkRoot, SourceRoot } from '../values.ts';
import { Hash } from '../../util/Hash.ts';
import { neverPromise, todo } from '../../util/functional.ts';
import { BlockStore } from '../../graph/BlockStore.ts';

// This implements ContractProvider, not a Contract.
// ContractProvider is a lower-level interface that allows more direct access to the scaffold context.
// In this case it's useful for more easily walking the block graph.
// In the future we should implement this as a Contract.

export class IoProbeContractProvider implements ContractProvider {
  constructor(private ctx: Context) {}

  generate(predicate: Predicate, put: PutRequest | undefined, draft: Draft, flowCtl: FlowCtl) {
    return todo();
  }

  verify(predicate: Predicate, block: Block, flowCtl: FlowCtl) {
    return todo();
  }

  buildParams(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    return todo();
  }

  buildBody(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    return todo();
  }

  walkParams(contract: Hash, params: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    return todo();
  }

  walkBody(contract: Hash, body: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    return todo();
  }

  debug?(predicate: Predicate): string | undefined {
    return `io_probe()`;
  }

  private probeBlock(
    block: Block,
    anchor: Block,
    query: Hash,
    signal: AbortSignal,
  ): Promise<Block> {
    if (signal.aborted) return neverPromise;

    return todo();
  }

  private resolveBlock(hash: Hash, signal: AbortSignal): Promise<Block> {
    if (signal.aborted) return neverPromise;

    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort());

    return new Promise((resolve) =>
      this.ctx.get(BlockStore).onIngest((x) => {
        if (Hash.equals(x.hash, hash)) {
          controller.abort();
          resolve(x);
        }
      }, controller.signal)
    );
  }
}
