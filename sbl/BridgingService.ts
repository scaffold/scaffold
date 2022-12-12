import Context from './Context.ts';
import Hash from './util/Hash.ts';
import ConnectionService from './ConnectionService.ts';
import ConnectionSpec from './ConnectionSpec.ts';
import NodeService, { Node } from './NodeService.ts';
import { getOrCreate } from './util/map.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import { BridgeEndMessage, BridgeStartMessage } from './messages.ts';
import MessageCtx from './MessageCtx.ts';

export default class BridgingService {
  private connectors: Map<string, {
    tryConnect(spec: ConnectionSpec): void;
  }> = new Map();

  constructor(private ctx: Context) {
  }

  public sendConnSpec(
    middle: Node,
    farNodeHash: Hash,
    connSpec: ConnectionSpec,
  ) {
    middle.defaultConn?.sendReliable({
      BridgeStartMessage: {
        dst_node_hash: farNodeHash,
        connection_spec: connSpec,
      },
    });
  }

  public handleBridgeStartMessage(msgCtx: MessageCtx, msg: BridgeStartMessage) {
    const node = this.ctx.get(NodeService).lookup(msg.dst_node_hash);
    if (node && node.defaultConn) {
      node.defaultConn.sendReliable({
        BridgeEndMessage: {
          src_node_hash: msgCtx.conn.node.hash,
          connection_spec: msg.connection_spec,
        },
      });
    }
  }

  public handleBridgeEndMessage(msgCtx: MessageCtx, msg: BridgeEndMessage) {
    const { protocol, data } = msg.connection_spec;
    const node = this.ctx.get(NodeService).lookup(msg.src_node_hash);
    this.ctx.get(NodeService)
      .provideConnection(msgCtx.conn.node, node, protocol)
      .tryConnect(data);
  }
}
