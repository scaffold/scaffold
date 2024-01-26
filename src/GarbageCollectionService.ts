import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { FactSource, FactType } from './FactMeta.ts';
import { FactService, invalidFact } from './FactService.ts';
import { frontierHash } from './constants.ts';
import { Hash } from './util/Hash.ts';

export class GarbageCollectionService {
  constructor(private ctx: Context) {}

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
        if (fact === invalidFact) {
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

        if (fact.frontierVoters.length > 0) {
          return false;
        }

        return !fact.inputs.some((input) => {
          const inputBlock = this.ctx.get(BlockService)
            .get(input.blockHash, false);
          return inputBlock !== undefined && Hash.equals(
            inputBlock.outputs[input.outputIdx].verifier.contractHash,
            frontierHash,
          );
        });
      },
    );

    if (candidates.length > 0) {
      const sel = candidates[Math.floor(Math.random() * candidates.length)];
      if (sel[1] === invalidFact) {
        this.ctx.get(FactService).getAll().delete(sel[0]);
      } else {
        console.log('DROP', candidates.length, sel[0]);
        this.ctx.get(FactService).forget(sel[1]);
      }
    }
  }
}
