import { Context } from '../Context.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { Connection } from '../Connection.ts';
import { ConnectionService } from '../ConnectionService.ts';

export class ConnectionRecordSet extends ReactiveRecordSet<Connection> {
  constructor(private ctx: Context) {
    super();
  }

  public getAll(): Iterable<Connection> {
    return this.ctx.get(ConnectionService).getAll();
  }
}
