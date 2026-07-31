import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { bin2hex } from '../util/hex.ts';
import { mapPut } from '../util/map.ts';
import { BlockStore } from './BlockStore.ts';
import { DraftStore } from './DraftStore.ts';
import { CancelError, ExecutionQueue, FlowCtl, Job } from './ExecutionQueue.ts';
import { Block, Draft, Predicate } from './types.ts';

declare const predicateKeySymbol: unique symbol;
type PredicateKey = string & { readonly [predicateKeySymbol]: true };

const predicateKey = (predicate: Predicate): PredicateKey =>
  `${predicate.contract.toHex()}:${bin2hex(predicate.params)}` as PredicateKey;

interface Execution {
  predicate: Predicate;

  // Generators should shift claims from this array
  availableClaims: { block: Block; outputIdx: bigint }[];

  runningJob?: Job;
}

/**
 * Turns newly-ingested outputs into contract executions.
 *
 * The unit of work is a *predicate*, not an output. A single execution sweeps
 * every matching UTXO through `claimAll`, so many outputs -- on this block, on
 * blocks ingested seconds apart -- collapse into one job.
 */
export class ExecutionModule {
  private pending = new Map<PredicateKey, Execution>();

  constructor(private ctx: Context) {
    this.ctx.get(BlockStore).onIngest((block) => this.onIngest(block));
  }

  private onIngest(block: Block) {
    for (let i = 0; i < block.payload.outputs.length; i++) {
      this.trigger(block, BigInt(i));
    }
  }

  private trigger(block: Block, outputIdx: bigint) {
    const output = block.payload.outputs[Number(outputIdx)];

    const predicate: Predicate = { contract: output.contract, params: output.params };
    const key = predicateKey(predicate);

    const exec = mapPut(this.pending, key, () => ({ predicate, availableClaims: [] }));
    exec.availableClaims.push({ block, outputIdx });

    if (exec.runningJob === undefined) {
      const job = new GenerationJob(this.ctx, exec);
      exec.runningJob = job;

      (async () => {
        await this.ctx.get(ExecutionQueue).run(job);
        this.ctx.get(ExecutionQueue).remove(job);
        exec.runningJob = undefined;

        if (exec.availableClaims.length === 0) {
          const deleted = this.pending.delete(key);
          assert(deleted);
        }
      })();
    }
  }
}

class GenerationJob implements Job {
  constructor(private ctx: Context, private execution: Execution) {}

  priority(): number {
    // Claimable value under this predicate. Dedup falls out of it: two outputs
    // under one predicate raise a single job's priority rather than creating
    // two jobs.
    //
    // Missing: the filter to triggers that are still unclaimed. And `triggers`
    // is itself a stand-in -- the real source is a predicate-keyed UTXO index
    // once v2 has one, since triggers only sees outputs we watched arrive, not
    // the ones already sitting unspent in the store.
    //
    // Number() is lossy past 2^53; this is an ordering, not an amount.
    let total = 0n;
    for (const { block, outputIdx } of this.execution.availableClaims) {
      total += block.payload.outputs[Number(outputIdx)].amount;
    }
    return Number(total);
  }

  async run(ctl: FlowCtl): Promise<void> {
    const draft = this.ctx.get(DraftStore).create();
    try {
      await this.ctx.get(this.ctx.config.contractProvider).generate(
        this.execution.predicate,
        (update) => this.ctx.get(DraftStore).update(draft, update),
        ctl.signal,
      );
      this.ctx.get(DraftStore).build(draft);
    } catch (err) {
      if (!(err instanceof CancelError)) {
        console.error(err);
      }

      this.ctx.get(DraftStore).cancel(draft);
    }
  }
}
