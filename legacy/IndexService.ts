import { assert } from './util/functional.ts';
import { Connection } from './Connection.ts';
import { Context } from './Context.ts';
import { Fact, FactType } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { mapPop, mapPut } from './util/map.ts';
import { RoutingService } from './RoutingService.ts';

interface Reception {
  timestamp: number;
  conn: Connection;
}

export class IndexService {
  private receptions = new Map<HashPrimitive, Reception[]>();

  constructor(private ctx: Context) {}

  ingestHash(conn: Connection, hash: Hash) {
    const now = this.ctx.config.timeProvider.now();

    const fact = this.ctx.get(FactService).get(hash, false);
    if (fact !== undefined) {
      this.sendFeedback(fact.fromConnections[0], conn, fact, now - fact.receivedAt);
    } else {
      mapPut(this.receptions, hash.toPrimitive(), () => []).push({ timestamp: now, conn });
    }
  }

  ingestFact(conn: Connection, fact: Fact) {
    this.sendFeedback(conn, conn, fact, 0);

    const now = this.ctx.config.timeProvider.now();

    for (const reception of mapPop(this.receptions, fact.hash.toPrimitive()) ?? []) {
      assert(reception.conn !== conn);
      this.sendFeedback(conn, reception.conn, fact, reception.timestamp - now);
    }
  }

  private sendFeedback(firstConn: Connection, toConn: Connection, fact: Fact, lagMs: number) {
    firstConn.get(RoutingService).addRecvDelay(toConn, lagMs);

    const feedback: Feedback = { hashes: [{ hash: fact.hash, lagMs }] };
    this.ctx.get(FactService).emit(feedback, Feedback, FactType.Feedback, toConn);
  }
}
