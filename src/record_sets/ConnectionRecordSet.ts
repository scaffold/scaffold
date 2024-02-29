import { Context } from '../Context.ts';
import { ReactiveRecordSet } from '../util/ReactiveRecordSet.ts';
import { Connection } from '../ConnectionService.ts';
import { ConnectionService } from '../ConnectionService.ts';

export class ConnectionRecordSet extends ReactiveRecordSet<Connection> {
  constructor(private ctx: Context) {
    super();
  }

  getAll(): Iterable<Connection> {
    return this.ctx.get(ConnectionService).getAll();
  }
}
