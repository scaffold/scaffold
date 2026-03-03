import { Context } from '../Context.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { SignalingService, SignalingState } from '../SignalingService.ts';

export class SignalingRecordSet extends ReactiveRecordSet<SignalingState> {
  constructor(ctx: Context) {
    super(ctx);
  }

  public getAll(): Iterable<SignalingState> {
    return this.ctx.get(SignalingService).getAllStates();
  }
}
