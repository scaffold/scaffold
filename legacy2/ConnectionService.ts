import { Context } from './Context.ts';
import { ConnectionDriver, ConnectionProvider } from './NetworkProvider.ts';
import { AuthenticatedPeer, PeerManager } from './PeerManager.ts';
import { assert, error } from './util/functional.ts';
import { FactService } from './FactService.ts';
import { Fact, FactBase, FactSource, FactType } from './FactMeta.ts';
import { arrEquals } from './util/buffer.ts';
import { KeyService } from './KeyService.ts';
import { PeerInfo } from './messages.ts';
import { bin2hex } from './util/hex.ts';
import { BarrierException } from './exceptions.ts';
import { RemotePeer } from './PeerManager.ts';
import { generateSillyName } from './util/sillyNameGenerator.ts';
import { ConnectionRecordSet } from './record_sets/ConnectionRecordSet.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { mapPut } from './util/map.ts';
import { Logger } from './Logger.ts';
import { LogSystem } from './Config.ts';
import { FingerprintSet } from './FingerprintSet.ts';
import { Connection } from './Connection.ts';

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

export interface Connection2 {
  name: string; // TODO: Remove; only for debugging

  // peer: AnonymousPeer | (RemotePeer & AuthenticatedPeer);
  remotePublicKey?: Uint8Array;
  remoteClientNonce?: string;

  sharedSecret?: Hash;

  protocol: string;

  provider: ConnectionProvider;
  sendReliable(data: Uint8Array): void;
  sendFast(data: Uint8Array): void;
  shutdown(): void;

  sendReliableCount: number;
  sendFastCount: number;
  recvCount: number;
  lastRecvTimestamp: number;
  reliability: number;
  isConnected: boolean;

  // Note that this will be shared between multi-connections with the same publicKey+nonce combo.
  knownFacts: Set<Fact>;

  // Note that this will be shared between multi-connections with the same publicKey+nonce combo.
  knownFacts2: FingerprintSet;
  sendFingerprintQueue: Hash[];

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

  earnedBandwidth: number;

  log?: Logger;
}

export class ConnectionService {
  // private connections: Map<string, Connection> = new Map();
  // private anonymousConns: {tryConnect(spec: string): void;}[] = [];

  private connections: Connection[] = [];
  private knownFactsByClient = new Map<HashPrimitive, Set<Fact>>();

  constructor(private ctx: Context) {}

  public getAll() {
    return this.connections;
  }

  public createConnection(
    protocol: string,
    provider: ConnectionProvider,
    remotePublicKey?: Uint8Array,
    remoteClientNonce?: string,
  ) {
    // const conn: Connection = {
    //   name: generateSillyName(this.ctx.config.entropyProvider),
    //   // peer,
    //   remotePublicKey,
    //   remoteClientNonce,
    //   protocol,
    //   provider,
    //   sendReliable: (data: Uint8Array) => {
    //     if (conn.isConnected) {
    //       try {
    //         provider.sendReliable(data);
    //       } catch (err) {
    //         onSendError(err);
    //       }

    //       conn.sendReliableCount++;
    //       this.ctx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(conn);
    //     }
    //   },
    //   sendFast: (data: Uint8Array) => {
    //     if (conn.isConnected) {
    //       try {
    //         provider.sendFast(data);
    //       } catch (err) {
    //         onSendError(err);
    //       }

    //       conn.sendFastCount++;
    //       this.ctx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(conn);
    //     }
    //   },
    //   shutdown,
    //   sendReliableCount: 0,
    //   sendFastCount: 0,
    //   recvCount: 0,
    //   lastRecvTimestamp: this.ctx.config.timeProvider.now(),
    //   reliability: 0.75,
    //   isConnected: true,
    //   knownFacts: remotePublicKey !== undefined && remoteClientNonce !== undefined
    //     ? mapPut(
    //       this.knownFactsByClient,
    //       Hash.digestParts(remotePublicKey, remoteClientNonce).toPrimitive(),
    //       () => new Set(),
    //     )
    //     : new Set(),
    //   ping: { latest: Infinity, min: Infinity, sum: 0, sqSum: 0, count: 0 },
    //   altruism: 0,
    //   earnedBandwidth: 0,

    //   log: Logger.create(this.ctx, LogSystem.Connection),
    // };

    const conn = new Connection(this.ctx, provider, remotePublicKey, remoteClientNonce);

    this.connections.push(conn);

    for (const peer of this.ctx.get(PeerManager).getAll()) {
      for (const [_, infoFact] of peer.clientInfoFacts) {
        this.ctx.get(FactService).sendTo(infoFact, conn);
      }
    }
    this.ctx.get(FactService).emit(
      this.ctx.get(PeerManager).makeInfo(),
      PeerInfo,
      FactType.PeerInfo,
      conn,
    );

    this.ctx.onDestruct(() => conn.close());

    return conn;
  }

  removeConnection(conn: Connection) {
    // assert(conn.peer.connections.delete(conn));
    const connIdx = this.connections.indexOf(conn);
    if (connIdx === -1) {
      throw new Error(`Cannot find connection!`);
    }
    this.connections.splice(connIdx, 1);
  }
}
