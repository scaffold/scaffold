import { BlockBuilder } from './BlockBuilder.ts';
import { Context } from './Context.ts';
import { DataTree } from './protocol/base.ts';

export class PutService {
  constructor(private ctx: Context) {}

  put(data: DataTree) {
    const fact = this.ctx.get(BlockBuilder).publishSingleDraft({ body: data });
    return fact.hash;
  }
}
