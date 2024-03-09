import { Context } from '../Context.ts';
import { InputSpec } from '../BlockBuilder.ts';
import { Verifier } from '../messages.ts';
import { QueueRecordSet } from './QueueRecordSet.ts';
import { UnspentOutputManager } from '../UnspentOutputManager.ts';

export class UnspentOutputRecordSet
  extends QueueRecordSet<Verifier, InputSpec> {
  constructor(private ctx: Context) {
    super(ctx.get(UnspentOutputManager));
  }
}
