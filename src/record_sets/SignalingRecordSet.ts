import { Context } from '../Context.ts';
import { ReactiveRecordSet } from '../util/ReactiveRecordSet.ts';
import { SignalingState, SignalingService } from '../SignalingService.ts';

export class SignalingRecordSet extends ReactiveRecordSet<SignalingState> {
  constructor(private ctx: Context) {
    super();
  }

  getAll(): Iterable<SignalingState> {
    return this.ctx.get(SignalingService).getAllStates();
  }
}
