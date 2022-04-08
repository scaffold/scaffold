import Context from './Context.ts';
import DhtTable, { DhtEntry } from './DhtTable.ts';
import Hash from './util/Hash.ts';
import NodeService from './NodeService.ts';
import { Connection } from './ConnectionService.ts';
import { error } from './util/functional.ts';
import { DhtJoinMessage } from './messages.ts';
import MessageCtx from './MessageCtx.ts';

const dhtEntryLifespanMs = 1000 * 60 * 60;

export default class DhtService {
  // Need to keep one table for use even when we haven't completed any work.
  // Peers won't respect it as valid since it doesn't have any proof of work.
  private selfTable: DhtTable;

  // Links incoming requests
  private earnedTables: DhtTable[] = [];

  constructor(private ctx: Context) {
    this.selfTable = new DhtTable(ctx, ctx.get(NodeService).getSelfHash());

    setInterval(() => {
      // TODO: Remove earned tables older than an hour
    }, 10000);
  }

  public handleDhtJoinMessage(msgCtx: MessageCtx, msg: DhtJoinMessage) {
    const entry = {
      answer: msg.hash,
      node: msgCtx.conn.node,
    };

    // Check answer hash
    // Get following epoch hash
    // Get answer cpus
    // Check isValidEntry

    this.selfTable.add(entry);
    for (const table of this.earnedTables) {
      table.add(entry);
    }
  }

  public getClosestEntry(key: Hash): DhtEntry | undefined {
    let bestDist: Hash = Hash.fromLiteral32(-1);
    let bestEntry;

    const testEntry = (entry: DhtEntry) => {
      const dist = Hash.xor(entry.answer, key);
      if (Hash.cmp(dist, bestDist) === -1) {
        bestDist = dist;
        bestEntry = entry;
      }
    };

    this.earnedTables.forEach((tbl) =>
      testEntry({
        answer: tbl.centerHash,
        node: this.ctx.get(NodeService).getSelfNode(),
      })
    );
    this.selfTable.forEach(testEntry);
    for (const table of this.earnedTables) {
      table.forEach(testEntry);
    }

    return bestEntry;
  }

  public submitWork(
    answerHash: Hash,
    followingEpochHash: Hash,
    answerCpuNs: number,
  ) {
    if (this.isValidEntry(answerHash, followingEpochHash, answerCpuNs)) {
      const newTable = new DhtTable(this.ctx, answerHash);
      for (const table of [this.selfTable, ...this.earnedTables]) {
        table.forEach((entry) => newTable.add(entry));
      }
      this.earnedTables.push(newTable);

      newTable.forEach((entry) =>
        entry.node.defaultConn?.sendReliable({
          DhtJoinMessage: { hash: answerHash },
        })
      );
    }
  }

  public isValidEntry(
    answerHash: Hash,
    followingEpochHash: Hash,
    answerCpuNs: number,
  ) {
    // TODO: Binary concatenation
    const h = Hash.digest(
      answerHash.toHex() + followingEpochHash.toHex() + answerCpuNs,
    );
    const threshold = Hash.fromFraction(answerCpuNs, 1e6 * dhtEntryLifespanMs);
    return Hash.cmp(h, threshold) === -1;
  }
}
