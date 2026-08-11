import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { bin2hex } from '../util/hex.ts';
import { mapPut } from '../util/map.ts';
import { BlockStore } from './BlockStore.ts';
import { Block, Output, OutputResolverType, Predicate, ResolvingClaim } from './types.ts';

interface IndexedOutput {
  producer: Block;
  outputIndex: number;
  output: Output;
}

export interface OutputLocation extends IndexedOutput {
  claims: ResolvingClaim[];
}

interface Subscriber {
  cb: (output: OutputLocation) => void;
  signal: AbortSignal;
}

interface PredicateEntry {
  outputs: IndexedOutput[];
  subscribers: Set<Subscriber>;
}

export class OutputIndex implements Disposable {
  private index = new Map<string, PredicateEntry>();

  private disposeController = new AbortController();

  constructor(private ctx: Context) {
    for (const block of ctx.get(BlockStore).getAll()) this.ingestBlock(block);
    ctx.get(BlockStore).onIngest((block) => this.ingestBlock(block), this.disposeController.signal);
  }

  [Symbol.dispose]() {
    this.disposeController.abort();
  }

  onOutput(predicate: Predicate, cb: (output: OutputLocation) => void, signal: AbortSignal) {
    if (signal.aborted) return;

    const entry = this.entry(predicate);
    const subscriber: Subscriber = { cb, signal };

    for (const location of entry.outputs) {
      this.deliver(subscriber, location);
      if (signal.aborted) return;
    }

    entry.subscribers.add(subscriber);
    signal.addEventListener('abort', () => assert(entry.subscribers.delete(subscriber)));
  }

  private ingestBlock(block: Block) {
    for (let i = 0; i < block.payload.outputs.length; i++) {
      const output = block.payload.outputs[i];
      const entry = this.entry(output);
      const location: IndexedOutput = { producer: block, outputIndex: i, output };

      // Index before dispatching: a subscriber registered from within a callback picks this
      // output up in its backfill, and the snapshot keeps it from also being dispatched to.
      entry.outputs.push(location);
      for (const subscriber of [...entry.subscribers]) {
        if (subscriber.signal.aborted) continue;
        this.deliver(subscriber, location);
      }
    }
  }

  // Claims move after a location is indexed, so they are read at delivery rather than stored.
  private deliver(subscriber: Subscriber, location: IndexedOutput) {
    const claims = (location.producer.resolvingOutputs.get(BigInt(location.outputIndex)) ?? [])
      .filter((x) => x.type === OutputResolverType.Claim);

    subscriber.cb({ ...location, claims });
  }

  private entry(predicate: Predicate): PredicateEntry {
    const key = `${predicate.contract.toPrimitive()}:${bin2hex(predicate.params)}`;
    return mapPut(this.index, key, () => ({ outputs: [], subscribers: new Set() }));
  }
}
