import { Connection } from '../Connection.ts';
import { Context } from '../Context.ts';
import { FactType } from '../FactMeta.ts';
import { FactService } from '../FactService.ts';
import { ReceptionProvider } from '../IngestionProvider.ts';
import { Hash } from '../util/Hash.ts';

export class IndexIngestor implements ReceptionProvider<FactType.Index> {
  type = FactType.Index as const;
  isTransient = true as const;

  constructor(private ctx: Context) {}

  handle(from: Connection, data: Uint8Array): void {
    const hash = Hash.fromBytes(data);
    const ref = this.ctx.get(FactService).getRef(hash);
    ref.receptions.push({ timestamp: this.ctx.config.timeProvider.now(), conn: from, full: false });
  }
}
