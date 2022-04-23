import secp from './util/secp.ts';
import Peer from './Peer.ts';
import MessageDispatcherService from './MessageDispatcherService.ts';
import Context from './Context.ts';
import { Connection } from './ConnectionService.ts';
import { bin2hex } from './util/hex.ts';
import NodeService from './NodeService.ts';
import { error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import { PingMessage, PongMessage } from './messages.ts';
import MessageCtx from './MessageCtx.ts';

const AVG_PING_INTERVAL_MS = 600000; // 10 minutes
const PING_TIMEOUT_MS = 10000;

export default class PingService {
  private pingResolvers: Map<string, () => void> = new Map();

  constructor(private ctx: Context) {
    this.tick();
  }

  private tick() {
    this.ctx.get(NodeService).getAll().forEach((node) =>
      node.connections.forEach(({ conn }) => conn && this.ping(conn))
    );

    setTimeout(() => this.tick(), AVG_PING_INTERVAL_MS * (Math.random() + 0.5));
  }

  public async ping(conn: Connection) {
    const secret = Hash.random();

    const startTime = Date.now();
    conn.sendFast({ PingMessage: { secret } });

    const promise = new Promise<void>((resolve, reject) => {
      this.pingResolvers.set(secret.toHex(), resolve);

      // TODO: What to do in this case?
      setTimeout(reject, PING_TIMEOUT_MS);
    });
    promise.finally(() => this.pingResolvers.delete(secret.toHex()));
    await promise;

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    conn.ping.latest = durationMs;
    conn.ping.min = Math.min(conn.ping.min, durationMs);
    conn.ping.sum += durationMs;
    conn.ping.sqSum += durationMs * durationMs;
    conn.ping.count++;

    return conn.ping;
  }

  public handlePingMessage(msgCtx: MessageCtx, msg: PingMessage) {
    msgCtx.conn.sendFast({ PongMessage: { secret: msg.secret } });
  }

  public handlePongMessage(_msgCtx: MessageCtx, msg: PongMessage) {
    const resolver = this.pingResolvers.get(msg.secret.toHex());
    if (resolver) {
      resolver();
    }
  }
}
