import { BlockService } from './BlockService.ts';
import { Connection } from './Connection.ts';
import { Context } from './Context.ts';
import { Fact, FactType } from './FactMeta.ts';
import { BinaryHeap } from '@std/data-structures';

interface Link {
  fact: Fact;
  amount: bigint;
}

export class QaService {
  constructor(private ctx: Context) {}

  *getAnswers(fact: Fact): Generator<Link, void, unknown> {
    if (fact.type === FactType.Block) {
      for (let i = 0; i < fact.outputs.length; i++) {
        for (const claim of fact.outputClaims[i]) {
          if (claim.block.isCanonical) {
            yield { fact: claim.block, amount: fact.outputs[i].amount };
          }
        }
      }
    }
  }

  *getQuestions(fact: Fact): Generator<Link, void, unknown> {
    if (fact.type === FactType.Block) {
      for (const input of fact.inputs) {
        const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
        if (inputBlock !== undefined) {
          yield { fact: inputBlock, amount: inputBlock.outputs[input.outputIdx].amount };
        }
      }
    }
  }
}
