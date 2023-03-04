import Context from './Context.ts';
import InfoService from './InfoService.ts';
import Logger from './Logger.ts';
import MessageDispatcherService from './MessageDispatcherService.ts';
import { Packet } from './messages.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import NodeService, { Node } from './NodeService.ts';
import Peer from './Peer.ts';
import PeerService from './PeerService.ts';
import { error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import secp from './util/secp.ts';

export const SELF_CONNECTION = Symbol('SELF_CONNECTION');
export type SELF_CONNECTION = typeof SELF_CONNECTION;

export interface Connection {
  node: Node;
  peer: Peer;

  provider: ConnectionProvider;
  sendReliable(message: Packet['message']): void;
  sendFast(message: Packet['message']): void;

  lastMsgTimestamp: number;

  ping: {
    latest: number;
    min: number;
    sum: number;
    sqSum: number;
    count: number;
  };
}

const SIGNATURE_LENGTH = 64;

// AuthenticationService?
export default class ConnectionService {
  // private connections: Map<string, Connection> = new Map();
  // private anonymousConns: {tryConnect(spec: string): void;}[] = [];

  constructor(private ctx: Context) {}

  public connect(protocol: string, spec: string) {
    console.log(`Attempting to connect via ${protocol} to ${spec}...`);

    const onListen = (spec: string) => {
      throw new Error(
        `onListen called with spec ${spec} but no way to send it to remote node`,
      );
    };
    const onNewConn = (provider: ConnectionProvider) =>
      this.initConnection(protocol, provider);
    const protocolProvider =
      this.ctx.config.networkProvider.protocols.get(protocol) ||
      error(`Protocol ${protocol} has no provider`);
    protocolProvider.createClient!(onListen, onNewConn).tryConnect(spec);
  }

  // public connect(protocol: string): { tryConnect(spec: string): void } {
  //   const onListen = (spec: string) => {
  //     console.error(
  //       `onListen called with spec ${spec} but no way to send it to remote node`,
  //     );
  //   };
  //   const onNewConn = (provider: ConnectionProvider) =>
  //     this.initConnection(protocol, provider);
  //   const protocolProvider = this.ctx.config.networkProvider.protocols.get(
  //     protocol,
  //   );
  //   if (!protocolProvider) {
  //     throw new Error(`Protocol ${protocol} has no provider`);
  //   }
  //   return protocolProvider.create(onListen, onNewConn);
  // }

  // private getRemoteNodeHash(
  //   provider: ConnectionProvider,
  // ): Promise<{ hash: Hash; packet: FbPacket }> {
  //   return new Promise((resolve, reject) => {
  //     provider.onRecv(async (data) => {
  //       try {
  //         const signature = data.subarray(0, SIGNATURE_LENGTH);
  //         if (signature.byteLength !== SIGNATURE_LENGTH) {
  //           throw new Error(
  //             `Signature length (${signature.byteLength}) is not exactly ${SIGNATURE_LENGTH}`,
  //           );
  //         }

  //         const msgData = data.subarray(SIGNATURE_LENGTH);
  //         const packet = Packet.getRootAsPacket(
  //           new flatbuffers.ByteBuffer(msgData),
  //         );

  //         if (packet.messageType() !== FbMessage.InfoMessage) {
  //           // If the first message wasn't an InfoMessage, then either:
  //           //   1. The remote peer is deviating from protocol, or
  //           //   2. It was sent over the fast channel and happened to get here before the first reliable message.
  //           // In both cases, it's safe to drop it.
  //           throw new Error(`First message is not an InfoMessage; dropping`);
  //         }
  //         const msg: FbInfoMessage = packet.message<FbInfoMessage>(
  //           new FbInfoMessage(),
  //         );

  //         const publicKey = msg.publicKeyArray();
  //         if (!publicKey || publicKey.byteLength !== PUBLIC_KEY_LENGTH) {
  //           throw new Error(
  //             `First InfoMessage doesn't include a valid public key; dropping`,
  //           );
  //         }

  //         const nonce = msg.nodeNonceArray();
  //         if (!nonce) {
  //           throw new Error(
  //             `First InfoMessage doesn't include a nonce; dropping`,
  //           );
  //         }

  //         if (
  //           !secp.verify(
  //             signature,
  //             (await Hash.digest(msgData)).toBytes(),
  //             publicKey,
  //           )
  //         ) {
  //           throw new Error(
  //             `Received InfoMessage but the signature doesn't verify`,
  //           );
  //         }

  //         const hash = await Hash.digest(arrConcat(publicKey, nonce));

  //         resolve({ hash, packet });
  //       } catch (err) {
  //         console.error(err);
  //       }
  //     });

  //     provider.onClose(reject);
  //   });
  // }

  public initConnection(
    protocol: string,
    provider: ConnectionProvider,
    // expectedNodeHash?: Hash,
  ) {
    console.log(
      `Connection established via ${protocol}; sending init packet...`,
    );

    this.ctx
      .get(InfoService)
      .makeInitPacket()
      .then((packet) => provider.sendReliable(packet));

    let conn: Connection | undefined;

    const onVerifyNodeHash = (hash: Hash, publicKey: Uint8Array) => {
      console.log(
        `Node hash verified via ${protocol}; connection successfully established.`,
      );

      const node = this.ctx.get(NodeService).lookup(hash);
      const onSendError = (err: unknown) => {
        if (conn) {
          console.error(
            `Caught error sending packet; closing connection: ${err}`,
          );
          provider.close();
          conn = undefined;
        }
      };
      conn = {
        node,
        peer: this.ctx.get(PeerService).lookup(publicKey),
        provider,
        sendReliable: (message: Packet['message']) =>
          this.composePacket(message)
            .then((packet) => provider.sendReliable(packet))
            .catch(onSendError),
        sendFast: (message: Packet['message']) =>
          this.composePacket(message)
            .then((packet) => provider.sendFast(packet))
            .catch(onSendError),
        lastMsgTimestamp: Date.now(),
        ping: { latest: Infinity, min: Infinity, sum: 0, sqSum: 0, count: 0 },
      };
      this.ctx.get(NodeService).addConnection(node, protocol, conn);
    };

    provider.onRecv((data) => {
      try {
        const signature = data.subarray(0, SIGNATURE_LENGTH);
        if (signature.byteLength !== SIGNATURE_LENGTH) {
          throw new Error(
            `Signature length (${signature.byteLength}) is not exactly ${SIGNATURE_LENGTH}`,
          );
        }

        const msgData = data.subarray(SIGNATURE_LENGTH);
        const msgHash = Hash.digest(msgData);
        const packet = Packet.decode(msgData);

        // console.log(
        //   `${this.ctx.config.debugName} received message from ${protocol}`,
        //   this.ctx.get(Logger).serialize(packet.message),
        // );

        if (conn) {
          if (!secp.verify(signature, msgHash.toBytes(), conn.peer.publicKey)) {
            throw new Error(
              `Received message but the signature doesn't verify`,
            );
          }
        } else {
          if (!('InfoMessage' in packet.message)) {
            // If the first message wasn't an InfoMessage, then either:
            //   1. The remote peer is deviating from protocol, or
            //   2. It was sent over the fast channel and happened to get here before the first reliable message.
            // In both cases, it's safe to drop it.
            console.error(`First message is not an InfoMessage; dropping`);
            return;
          }
          const msg = packet.message.InfoMessage;

          if (
            !secp.verify(
              signature,
              Hash.digest(msgData).toBytes(),
              msg.public_key,
            )
          ) {
            throw new Error(
              `Received InfoMessage but the signature doesn't verify`,
            );
          }

          // TODO: Prevent replay attacks with a challenge/response thing here

          const hash = this.ctx
            .get(NodeService)
            .computeNodeHash(msg.public_key, msg.node_nonce);

          // if (expectedNodeHash && !Hash.equals(hash, expectedNodeHash)) {
          //   throw new Error(`Node hash doesn't match what was expected`);
          // }

          onVerifyNodeHash(hash, msg.public_key);
        }

        this.ctx.get(MessageDispatcherService).dispatch({
          conn: conn!,
          packet,
          signature,
          msgData,
          msgHash,
          packetData: data,
        });
      } catch (err) {
        console.error(err);
        // provider.close();
      }
    });

    provider.onClose(() => {
      if (conn) {
        this.ctx.get(NodeService).removeConnection(conn.node, protocol, conn);
      }
    });
  }

  public async composePacket(message: Packet['message']) {
    // console.log(
    //   `${this.ctx.config.debugName} sending message`,
    //   this.ctx.get(Logger).serialize(message),
    // );

    let buf: Uint8Array;
    const msg = Packet.encode({ message }, (size) => {
      buf = new Uint8Array(SIGNATURE_LENGTH + size);
      return buf.subarray(SIGNATURE_LENGTH);
    });

    const sig = await secp.sign(
      Hash.digest(msg).toBytes(),
      this.ctx.config.selfPrivateKey,
      { canonical: true, der: false, extraEntropy: secp.utils.randomBytes(32) },
    );
    if (sig.byteLength !== SIGNATURE_LENGTH) {
      throw new Error(`Internal error: Unexpected signature length!`);
    }
    buf!.set(sig);
    return buf!;
  }
}
