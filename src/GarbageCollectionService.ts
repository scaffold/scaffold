import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { Fact, FactSource, FactType } from './FactMeta.ts';
import { FactService, ingestingFact } from './FactService.ts';

export class GarbageCollectionService {
  private tick = 0;

  constructor(private ctx: Context) {}

  public markVisited(fact: Fact) {
    fact.visitedAt = this.tick++;
    fact.visitedBy = new Error().stack;
  }

  public collect() {
    const drop = this.ctx.get(FactService).getSize() -
      this.ctx.config.targetFactCount;
    for (let i = 0; i < drop; i++) {
      this.dropOldFact();
    }
  }

  private dropOldFact() {
    const candidates = [...this.ctx.get(FactService).getAll().entries()].filter(
      ([_, fact]) => {
        if (fact === ingestingFact) {
          return true;
        }

        if (fact.references > 0) {
          return false;
        }

        if (fact.type !== FactType.Block) {
          return true;
        }

        if (fact.source === FactSource.Genesis) {
          return false;
        }

        if (fact.children.length > 0) {
          return false;
        }

        return !fact.inputs.some((input) => {
          const inputBlock = this.ctx.get(BlockService)
            .get(input.blockHash, false);
          return inputBlock !== undefined &&
            input.outputIdx === inputBlock.frontierOutputIdx;
        });
      },
    );

    let bestCandidate: Fact | undefined;
    for (const [_key, cd] of candidates) {
      if (
        cd !== ingestingFact &&
        (bestCandidate === undefined || cd.visitedAt < bestCandidate.visitedAt)
      ) {
        bestCandidate = cd;
      }
    }
    if (bestCandidate !== undefined) {
      this.ctx.get(FactService).forget(bestCandidate);
    }

    // if (candidates.length > 0) {
    //   const sel = candidates[Math.floor(Math.random() * candidates.length)];
    //   if (sel[1] === ingestingFact) {
    //     this.ctx.get(FactService).getAll().delete(sel[0]);
    //   } else {
    //     console.log('DROP', candidates.length, sel[0]);
    //     this.ctx.get(FactService).forget(sel[1]);
    //   }
    // }
  }
}
