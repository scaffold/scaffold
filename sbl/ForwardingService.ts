import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import { Connection, SELF_CONNECTION } from './ConnectionService.ts';
import Context from './Context.ts';
import MessageCtx from './MessageCtx.ts';
import { ForwardingFeedback, PublishMessage } from './messages.ts';
import NodeService, { Node } from './NodeService.ts';
// import ActionExecutor from './ActionExecutor.ts';
import { getOrCreate } from './util/map.ts';

export default class ForwardingService {
  private connIds: WeakMap<Connection, number> = new WeakMap();
  private nextConnId = 0;

  private nodeIds: WeakMap<Node, number> = new WeakMap();
  private nextNodeId = 0;

  private forwardingFeedback: Map<number, { sum: number; count: number }> =
    new Map();

  constructor(private ctx: Context) {}

  // TODO: Forward answer, not publication
  public forwardPublication(
    msg: PublishMessage,
    from: Connection | SELF_CONNECTION,
  ) {
    this.ctx
      .get(NodeService)
      .getAll()
      .forEach((node) => {
        if (from === SELF_CONNECTION || this.get(from, node).sum >= 0) {
          node.defaultConn?.sendReliable({ PublishMessage: msg });
        }
      });
  }

  public sendForwardingFeedback(node: Node, answer: Answer) {
    node.defaultConn?.sendReliable({
      ForwardingFeedback: {
        answer_hash: answer.hash,
        relative_time_ms: Date.now() - answer.receptionTime,
      },
    });
  }

  public handleForwardingFeedback(msgCtx: MessageCtx, msg: ForwardingFeedback) {
    const answer = this.ctx.get(AnswerRegistry).peek(msg.answer_hash);
    if (answer && answer.receivedFrom !== SELF_CONNECTION) {
      const feedback = this.get(answer.receivedFrom, msgCtx.conn.node);
      feedback.sum *= 0.99;
      feedback.sum += msg.relative_time_ms;
      feedback.count++;
    }
  }

  private get(src: Connection, dst: Node) {
    // TODO: Track from Conn to Conn?
    const connId = getOrCreate(this.connIds, src, () => this.nextConnId++);
    const nodeId = getOrCreate(this.nodeIds, dst, () => this.nextNodeId++);
    const key = (connId << 16) + nodeId;
    return getOrCreate(this.forwardingFeedback, key, () => ({
      sum: 0,
      count: 0,
    }));
  }
}
