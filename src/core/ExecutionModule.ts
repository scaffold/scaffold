import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { bin2hex } from '../util/hex.ts';
import { mapPut } from '../util/map.ts';
import { BlockStore } from './BlockStore.ts';
import { CancelError, ExecutionQueue, FlowCtl, Job } from './ExecutionQueue.ts';
import { Block, Predicate } from './types.ts';

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
      const job = new GenerationJob(exec);
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
  constructor(private execution: Execution) {}

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
    try {
      return await this._run(ctl);
    } catch (err) {
      if (!(err instanceof CancelError)) {
        console.error(err);
      }
    }
  }

  private _run(ctl: FlowCtl): Promise<void> {
    // Everything below wants to be inside a try, with the onFinished call in a
    // finally, so the entry is released on every path.
    //
    // 1. Re-read the claimable set for `pending.predicate`. Empty means it was
    //    all claimed while we sat in the queue: debug, return, no block.
    //
    // 2. Load the contract for `predicate.contract` through the plugin chain.
    //    Not resolvable locally (contract block not fetched yet) -> debug and
    //    return; ingesting that block re-triggers us.
    //
    // 3. Build a GeneratingEnv bound to this predicate and
    //    `await contract.run(env, signal)`:
    //      - ContractRejection  -> the contract declined these inputs. debug.
    //      - any other throw    -> crash. warn.
    //      - signal aborted     -> return quietly.
    //
    // 4. On success hand the env's accumulated claims/refs/outputs to
    //    DraftStore.create(), then build(). The draft is the sink; the env
    //    never touches the block builder itself.
    return Promise.resolve();
  }
}
