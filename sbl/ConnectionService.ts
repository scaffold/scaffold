import BlockService from './BlockService.ts';
import Context from './Context.ts';
import InfoService from './InfoService.ts';
import { InfoMessage, Packet } from './messages.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import NodeService, { Node } from './NodeService.ts';
import Peer from './Peer.ts';
import PeerService from './PeerService.ts';
import { assert, error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import BlockSetService from '~/sbl/BlockSetService.ts';
import FactService from '~/sbl/FactService.ts';
import { FactSource } from '~/sbl/FactMeta.ts';
import NetworkService from '~/sbl/NetworkService.ts';

// Private key length: 32 bytes
// Full public key length: 65 bytes
// Compressed public key length: 33 bytes
// Signature length: 64 bytes
// Hash length: 32 bytes

// export const SELF_CONNECTION = Symbol('SELF_CONNECTION');
// export type SELF_CONNECTION = typeof SELF_CONNECTION;

export interface Connection {
  node: Node;

  protocolName: string;

  provider: ConnectionProvider;
  sendReliable(data: Uint8Array): void;
  sendFast(data: Uint8Array): void;
  shutdown(): void;

  lastMsgTimestamp: number;

  ping: {
    latest: number;
    min: number;
    sum: number;
    sqSum: number;
    count: number;
  };

  // Altruism increases when we recieve helpful facts from the node
  // Altruism decreases when we send (hopefully helpful) facts to the node
  // We publish to positively altruistic nodes
  altruism: number;
}

export default class ConnectionService {
  // private connections: Map<string, Connection> = new Map();
  // private anonymousConns: {tryConnect(spec: string): void;}[] = [];

  // private connections: Connection[] = [];

  constructor(private ctx: Context) {}

  public createConnection(
    publicKey: Uint8Array,
    protocolName: string,
    provider: ConnectionProvider,
  ) {
    let isOnline = true;
    const shutdown = () => {
      if (isOnline) {
        isOnline = false;
        provider.shutdown();
        assert(conn.node.connections.delete(conn));
      }
    };

    const onSendError = (err: unknown) => {
      console.error(`Caught error sending packet; closing connection: ${err}`);
      shutdown();
    };

    const conn: Connection = {
      node: this.ctx.get(NodeService).getOrCreate(publicKey),
      protocolName,
      provider,
      sendReliable: (data: Uint8Array) => {
        try {
          provider.sendReliable(data);
        } catch (err) {
          onSendError(err);
        }
      },
      sendFast: (data: Uint8Array) => {
        try {
          provider.sendFast(data);
        } catch (err) {
          onSendError(err);
        }
      },
      shutdown,
      lastMsgTimestamp: Date.now(),
      ping: { latest: Infinity, min: Infinity, sum: 0, sqSum: 0, count: 0 },
      altruism: 0,
    };

    conn.node.connections.add(conn);

    provider.onClose(shutdown);
    this.ctx.onDestruct(shutdown);

    provider.onRecv((data) => {
      try {
        this.ctx.get(FactService).ingest(data, FactSource.Remote, conn!.node);
        conn.lastMsgTimestamp = this.ctx.config.timeProvider.now();
      } catch (err) {
        console.error(err);
        shutdown();
      }
    });
  }
}
