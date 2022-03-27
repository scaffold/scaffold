import MessageDispatcherService from './MessageDispatcherService.ts';
import Hash from './util/Hash.ts';
import Context from './Context.ts';
import {ConnectionProvider} from './NetworkProvider.ts'
import ConnectionService, { Connection } from './ConnectionService.ts';
import ConnectionSpec from './ConnectionSpec.ts'

interface ConnDiscovery {
  lastPeerList: number;
}

export default class DiscoveryService {
  private connDiscovery: WeakMap<Connection, ConnDiscovery> = new WeakMap();

  constructor(private ctx: Context) {
    setInterval(() => this.tick(), 1000);
  }

  private tick() {
    const threshold = Date.now() - 60000;
    this.ctx.get(ConnectionService).getAll().forEach((conn) => {
      let cd = this.connDiscovery.get(conn);
      if (!cd) {cd = { lastPeerList: 0 };
      this.connDiscovery.set(conn, cd);}
      if (cd.lastPeerList < threshold) {
        this.requestPeerList(conn);
      }
    });
  }

  private requestPeerList(conn: Connection) {
    conn.sendReliable({ type: 'peers_req' });
  }

  private sendPeerList(conn: Connection) {
    const peers = Array.from(
      this.ctx.get(ConnectionService).getAll().values(),
      (conn) => ({
        nodeId: conn.nodeId,
        publicKeys: conn.peers.map((p) => p.publicKey),
        minPing: conn.ping.min,
        avgPing: conn.ping.sum / conn.ping.count,

        // Have to send the publicKey and the node nonce
      }),
    );

    conn.sendReliable({ type: 'peers_reply', peers });
  }

  private handlePeerList(conn: Connection, reply: any) {
    reply.peers;
  }

  private makeNode(bridge: Connection, toNodeHash: Hash) {

    const onListen= (spec: ConnectionSpec) => {if(!node.conn) {bridge.}};
    const onNewConn= (provider: ConnectionProvider) => node.conn = this.ctx.get(ConnectionService).makeConnection(provider);
    const connector = this.ctx.config.networkProvider.create(onListen, onNewConn);
const node: Node = {connector};

    bridge.sendReliable()
  }
}
