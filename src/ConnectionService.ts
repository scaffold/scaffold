import { Context } from './Context.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import { Peer, PeerManager } from './PeerManager.ts';
import { assert, error } from './util/functional.ts';
import { FactService } from './FactService.ts';
import { Fact, FactBase, FactSource, FactType } from './FactMeta.ts';
import { NetworkService } from './NetworkService.ts';
import { SignalingService } from './SignalingService.ts';
import { arrEquals } from './util/buffer.ts';
import { KeyService } from './KeyService.ts';
import { Identification } from './messages.ts';
import { bin2hex } from './util/hex.ts';
import { BarrierException } from './exceptions.ts';
import { log } from '../deps.ts';
import { ConnectionGateway } from './ConnectionGateway.ts';

// Private key length: 32 bytes
// Full public key length: 65 bytes
// Compressed public key length: 33 bytes
// Signature length: 64 bytes
// Hash length: 32 bytes

// export const SELF_CONNECTION = Symbol('SELF_CONNECTION');
// export type SELF_CONNECTION = typeof SELF_CONNECTION;

export interface Connection {
  node?: Peer;

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

  knownFacts: Set<Fact>;
}

export class ConnectionService {
  // private connections: Map<string, Connection> = new Map();
  // private anonymousConns: {tryConnect(spec: string): void;}[] = [];

  // private connections: Connection[] = [];

  constructor(private ctx: Context) {}

  public createConnection(
    protocolName: string,
    provider: ConnectionProvider,
    requirePublicKey?: Uint8Array,
  ) {
    let isOnline = true;
    const shutdown = () => {
      if (isOnline) {
        isOnline = false;
        provider.shutdown();
        if (conn.node?.isRemote) {
          assert(conn.node.connections.delete(conn));
        }
      }
    };

    const onSendError = (err: unknown) => {
      console.error(`Caught error sending packet; closing connection: ${err}`);
      shutdown();
    };

    const conn: Connection = {
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
      knownFacts: new Set(),
    };

    provider.onClose(shutdown);
    this.ctx.onDestruct(shutdown);

    provider.onRecv((data) => {
      try {
        conn.lastMsgTimestamp = this.ctx.config.timeProvider.now();

        const fact = this.ctx.get(FactService)
          .ingest(data, FactSource.Remote, conn);
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
            requirePublicKey !== undefined &&
            !arrEquals(publicKey, requirePublicKey)
          ) {
            throw new Error(`Incorrect remote identification!`);
          }

          conn.node = this.ctx.get(PeerManager).getOrCreate(publicKey);
          if (!conn.node.isRemote) {
            throw new Error(`Internal error!`);
          }
          conn.node.connections.add(conn);

          console.log(`Connected and authenticated with ${bin2hex(publicKey)}`);

          if (requirePublicKey === undefined) {
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

    if (requirePublicKey !== undefined) {
      this.sendIdentification(conn, requirePublicKey);
    }

    this.ctx.get(ConnectionGateway).getState(conn);
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
}
