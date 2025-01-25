import { Context } from '../Context.ts';
import { InputSpec } from '../BlockBuilder.ts';
import { Verifier } from '../messages.ts';
import { QueueRecordSet } from './QueueRecordSet.ts';
import { AvailableOutputManager } from '../AvailableOutputManager.ts';

export class AvailableOutputRecordSet extends QueueRecordSet<Verifier, InputSpec> {
  constructor(private ctx: Context) {
    super(ctx.get(AvailableOutputManager));
  }
}
