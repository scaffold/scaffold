import Context from './Context.ts';
import BridgingService from './BridgingService.ts';
import NodeService from './NodeService.ts';
import PingService from './PingService.ts';
import DhtService from './DhtService.ts';
// import SubscriptionService from './SubscriptionService.ts';
// import PublicationService from './PublicationService.ts';
// import CollateralService from './CollateralService.ts';
import MessageCtx from './MessageCtx.ts';
import BlockService from './BlockService.ts';

export class BadMessageError extends Error {
  constructor(msg: string, public trustDelta: number) {
    super(msg);
    Object.setPrototypeOf(this, BadMessageError.prototype);
  }
}

export default class MessageDispatcherService {
  constructor(private ctx: Context) {
    // TODO: Do we need this?
    ctx.get(PingService);
  }

  public dispatch(msgCtx: MessageCtx) {
    // type KeysOfUnion<T> = T extends T ? keyof T : never;
    // type MsgTypes = KeysOfUnion<Packet['message']>;

    // const handlers: {
    //   [K in MsgTypes]: (msg: Extract<Packet['message'], { K: {} }>) => void;
    // } = {
    //   InfoMessage: (msg: InfoMessage) =>
    //     this.ctx.get(NodeService).handleInfoMessage(conn, msg),
    // };

    const msg = msgCtx.packet.message;

    if ('InfoMessage' in msg) {
      this.ctx.get(NodeService).handleInfoMessage(
        msgCtx.conn.node,
        msg.InfoMessage,
      );
    }

    if ('PingMessage' in msg) {
      this.ctx.get(PingService).handlePingMessage(msgCtx, msg.PingMessage);
    }

    if ('PongMessage' in msg) {
      this.ctx.get(PingService).handlePongMessage(msgCtx, msg.PongMessage);
    }

    if ('BridgeStartMessage' in msg) {
      this.ctx.get(BridgingService).handleBridgeStartMessage(
        msgCtx,
        msg.BridgeStartMessage,
      );
    }

    if ('BridgeEndMessage' in msg) {
      this.ctx.get(BridgingService).handleBridgeEndMessage(
        msgCtx,
        msg.BridgeEndMessage,
      );
    }

    if (this.ctx.config.onlyBridge) {
      return;
    }

    if ('PublicationMessage' in msg) {
      msgCtx.conn.node.knownBlocks.add(msg.PublicationMessage.block);
      this.ctx.get(BlockService).ingest(
        msg.PublicationMessage.block,
        msgCtx.conn.node.hash,
      );
    }
    // if ('RequestBlockMessage' in msg) {
    //   (async () => {
    //     const block = await this.ctx.get(BlockFetcher).get(
    //       msg.RequestBlockMessage.hash,
    //     );
    //     msgCtx.conn.sendReliable({ PublicationMessage: { block } });
    //   })();
    // }

    // if ('SubscribeMessage' in msg) {
    //   this.ctx.get(SubscriptionService).handleSubscribeMessage(
    //     msgCtx,
    //     msg.SubscribeMessage,
    //   );
    // }

    // if ('PublishMessage' in msg) {
    //   this.ctx.get(PublicationService).handlePublishMessage(
    //     msgCtx,
    //     msg.PublishMessage,
    //   );
    // }

    // if ('CollateralMessage' in msg) {
    //   this.ctx.get(CollateralService).handleCollateralMessage(
    //     msgCtx,
    //     msg.CollateralMessage,
    //   );
    // }

    if ('BribeMessage' in msg) {}

    if ('DhtJoinMessage' in msg) {
      this.ctx.get(DhtService).handleDhtJoinMessage(msgCtx, msg.DhtJoinMessage);
    }

    // if (msg.dst) {
    //   const dst = Hash.fromHex(msg.dst);
    //   const entry = this.ctx.get(DhtService).getClosestEntry(dst);
    //   if (entry && entry.client !== this.ctx.config.selfId) {
    //     this.send(entry.client, msg);
    //   }
    // }

    // const cb = this.handlers.get(msg.type);
    // if (!cb) {
    //   throw new Error(`Msg contained unexpected type ${msg.type}`);
    // }

    // try {
    //   await cb(conn, peer, msg, signed);
    // } catch (err) {
    //   if (err instanceof BadMessageError) {
    //     console.error(err.message);
    //     this.ctx.get(TrustService).changeTrust(peer, err.trustDelta);
    //   } else {
    //     throw err;
    //   }
    // }
  }
}
