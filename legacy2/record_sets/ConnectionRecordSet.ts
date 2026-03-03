import { Context } from '../Context.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { Connection } from '../Connection.ts';
import { ConnectionService } from '../ConnectionService.ts';

export class ConnectionRecordSet extends ReactiveRecordSet<Connection> {
  constructor(ctx: Context) {
    super(ctx);
  }

  public getAll(): Iterable<Connection> {
    return this.ctx.get(ConnectionService).getAll();
  }
}
