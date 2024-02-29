import { Context } from './Context.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import { AuthenticatedPeer, PeerManager } from './PeerManager.ts';
import { assert, error } from './util/functional.ts';
import { FactService } from './FactService.ts';
import { Fact, FactBase, FactSource, FactType } from './FactMeta.ts';
import { arrEquals } from './util/buffer.ts';
import { KeyService } from './KeyService.ts';
import { Identification, PeerInfo } from './messages.ts';
import { bin2hex } from './util/hex.ts';
import { BarrierException } from './exceptions.ts';
import { log } from '../deps.ts';
import { ConnectionGateway } from './ConnectionGateway.ts';
import { RemotePeer } from './PeerManager.ts';

// Private key length: 32 bytes
// Full public key length: 65 bytes
// Compressed public key length: 33 bytes
// Signature length: 64 bytes
// Hash length: 32 bytes

// export const SELF_CONNECTION = Symbol('SELF_CONNECTION');
// export type SELF_CONNECTION = typeof SELF_CONNECTION;

export interface AnonymousPeer extends RemotePeer {
  publicKey: undefined;
}

export interface Connection {
  peer: AnonymousPeer | (RemotePeer & AuthenticatedPeer);

  protocol: string;

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

export class ConnectionService {
  // private connections: Map<string, Connection> = new Map();
  // private anonymousConns: {tryConnect(spec: string): void;}[] = [];

  // private connections: Connection[] = [];

  constructor(private ctx: Context) {}

  public createConnection(
    protocol: string,
    provider: ConnectionProvider,
    remotePublicKey?: Uint8Array,
  ) {
    const peer = remotePublicKey !== undefined
      ? this.ctx.get(PeerManager).putPeer(remotePublicKey)
      : this.createAnonymousPeer();
    if (!peer.isRemote) {
      throw new Error(`Cannot connect to self!`);
    }

    let isOnline = true;
    const shutdown = () => {
      if (isOnline) {
        isOnline = false;
        provider.shutdown();
        assert(conn.peer.connections.delete(conn));

        for (const fact of conn.peer.knownFacts) {
          fact.fromConnections = fact.fromConnections.filter((x) => x !== conn);
          fact.toConnections = fact.toConnections.filter((x) => x !== conn);
        }
      }
    };

    const onSendError = (err: unknown) => {
      console.error(`Caught error sending packet; closing connection: ${err}`);
      shutdown();
    };

    const conn: Connection = {
      peer,
      protocol,
      provider,
      sendReliable: (data: Uint8Array) => {
        if (isOnline) {
          try {
            provider.sendReliable(data);
          } catch (err) {
            onSendError(err);
          }
        }
      },
      sendFast: (data: Uint8Array) => {
        if (isOnline) {
          try {
            provider.sendFast(data);
          } catch (err) {
            onSendError(err);
          }
        }
      },
      shutdown,
      lastMsgTimestamp: Date.now(),
      ping: { latest: Infinity, min: Infinity, sum: 0, sqSum: 0, count: 0 },
      altruism: 0,
    };
    conn.peer.connections.add(conn);

    provider.onClose(shutdown);
    this.ctx.onDestruct(shutdown);

    provider.onRecv((data) => {
      try {
        conn.lastMsgTimestamp = this.ctx.config.timeProvider.now();

        const fact = this.ctx.get(FactService)
          .ingest(data, FactSource.Remote, conn);

        // TODO: We don't have to do this extra authenetication, since we're already creating connections with authenticated peers
        if (fact.type === FactType.Identification) {
          this.ctx.get(FactService).forget(fact);

          if (
            !arrEquals(
              fact.publicKey,
              this.ctx.get(KeyService).getSelfPublicKey(),
            )
          ) {
            throw new Error(`Incorrect self identification!`);
          }

          const publicKey = this.ctx.get(FactService).getPublicKey(fact);
          if (
            remotePublicKey !== undefined &&
            !arrEquals(publicKey, remotePublicKey)
          ) {
            throw new Error(`Incorrect remote identification!`);
          }

          console.log(`Connected and authenticated with ${bin2hex(publicKey)}`);

          if (remotePublicKey === undefined) {
            this.sendIdentification(conn, publicKey);
          }
        }
      } catch (err) {
        if (err instanceof BarrierException) {
          if (log.LogLevels.DEBUG >= this.ctx.config.logLevel) {
            console.debug(err);
          }
        } else {
          console.error(err);
          shutdown();
        }
      }
    });

    if (remotePublicKey !== undefined) {
      this.sendIdentification(conn, remotePublicKey);
    }

    this.ctx.get(ConnectionGateway).getState(conn);

    this.ctx.get(FactService).emit(
      this.ctx.get(PeerManager).makeInfo(),
      PeerInfo,
      FactType.PeerInfo,
      conn,
    );
  }

  public createIdentificationFact(base: FactBase) {
    return Object.assign(
      base,
      Identification.decode(base.message),
      { type: FactType.Identification as const },
    );
  }

  private sendIdentification(conn: Connection, remotePublicKey: Uint8Array) {
    const identData = this.ctx.get(FactService).compose(
      { publicKey: remotePublicKey },
      Identification,
      FactType.Identification,
    );
    conn.sendReliable(identData);
  }

  private createAnonymousPeer(): AnonymousPeer {
    return {
      isRemote: true,
      connections: new Set(),
      knownFacts: new Set(),
      trust: 0,
      altruism: 0,
      publicKey: undefined,
    };
  }
}
