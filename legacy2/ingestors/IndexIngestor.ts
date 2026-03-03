import { Connection } from '../Connection.ts';
import { Context } from '../Context.ts';
import { FactType } from '../FactMeta.ts';
import { FactService } from '../FactService.ts';
import { ReceptionProvider } from '../IngestionProvider.ts';
import { Index } from '../protocol/channel.ts';
import { QaService } from '../QaService.ts';
import { RoutingService } from '../RoutingService.ts';
import { Hash } from '../util/Hash.ts';

export class IndexIngestor implements ReceptionProvider<FactType.Index> {
  type = FactType.Index as const;
  isTransient = true as const;

  constructor(private ctx: Context) {}

  handle(from: Connection, data: Uint8Array): void {
    const index = Index.decode(data);
    for (const info of index.hashes) {
      const ref = this.ctx.get(FactService).getRef(info.hash);
      if (info.isRequest !== null) {
        if (info.isRequest.boolean) {
          ref.requesting.add(from);

          for (const answer of this.ctx.get(QaService).getAnswers(ref)) {
            from.get(RoutingService).enqueue(answer.fact);
          }
        } else {
          ref.requesting.delete(from);
        }
      }

      from.get(RoutingService).addReception(ref, false);

      if (info.lagMs !== null) {
        from.get(RoutingService).recvFeedback(ref.hash, info.lagMs.int);
      }

      ref.log?.debug(`Received index ${info.hash.toHex()} from conn ${from.sillyName}`, {
        isRequest: info.isRequest,
        lagMs: info.lagMs,
      });
    }
  }
}
