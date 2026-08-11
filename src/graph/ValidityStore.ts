import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { mapPut } from '../util/map.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { BlockStore } from './BlockStore.ts';
import { BlockIngestor } from './Ingestor.ts';
import { Block, ResolvingClaim } from './types.ts';
import { VerificationJob } from './VerificationJob.ts';

export class ValidityStore {
  private validities = new Map<Block, MaybePromise<boolean>>();
  private validityListeners = new Set<(block: Block, isValid: boolean) => void>();

  private disposeController = new AbortController();

  constructor(private ctx: Context) {
    for (const block of ctx.get(BlockStore).getAll()) {
      for (const claim of block.claims) {
        if (claim.resolved) this.resolveClaim(claim)
      }
    }
    ctx.get(BlockIngestor).onClaimResolution(claim => this.resolveClaim(claim), this.disposeController.signal);
  }

  [Symbol.dispose]() {
    this.disposeController.abort();
  }





  onValidity(cb: (block: Block, isValid: boolean) => void, signal: AbortSignal) {
    if (signal.aborted) return;
    this.validityListeners.add(cb);
    signal.addEventListener('abort', () => assert(this.validityListeners.delete(cb)));
  }

  isValid(block: Block) {
    return mapPut(this.validities,block, () => new Promise(resolve=>{

    })


      {


    const job = new VerificationJob(this.ctx);
    this.ctx.get(ExecutionQueue).run(job)
      .then(() => this.ctx.get(ExecutionQueue).remove(job));

    });
  }

  private resolveClaim(claim: ResolvingClaim) {

  }

  private getPredicates(block:Block) {

  }
}
