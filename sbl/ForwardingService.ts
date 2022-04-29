import Context from './Context.ts';
import QuestionService from './QuestionService.ts';
import AnswerService from './AnswerService.ts';
import { Connection, SELF_CONNECTION } from './ConnectionService.ts';
import { error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import NodeService, { Node } from './NodeService.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import {
  FeedbackMessage,
  ForwardingFeedback,
  License,
  PublishMessage,
} from './messages.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import MessageCtx from './MessageCtx.ts';
import IncentiveService from './IncentiveService.ts';
import { assert } from './util/functional.ts';
import RewardSpec from './RewardSpec.ts';
import EnvoyContract from '~/graph/EnvoyContract.ts';
import * as envoyMessages from '~/graph/envoyMessages.ts';
// import ActionExecutor from './ActionExecutor.ts';
import { getOrCreate } from './util/map.ts';

export default class ForwardingService {
  private connIds: WeakMap<Connection, number> = new WeakMap();
  private nextConnId = 0;

  private nodeIds: WeakMap<Node, number> = new WeakMap();
  private nextNodeId = 0;

  private forwardingFeedback: Map<number, { sum: number }> = new Map();

  constructor(private ctx: Context) {}

  public forwardPublication(from: Connection, msg: PublishMessage) {
    this.ctx.get(NodeService).getAll().forEach((node) => {
      if (this.get(from, node).sum >= 0) {
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
    }
  }

  private get(src: Connection, dst: Node) {
    // TODO: Track from Conn to Conn?
    const connId = getOrCreate(this.connIds, src, () => this.nextConnId++);
    const nodeId = getOrCreate(this.nodeIds, dst, () => this.nextNodeId++);
    const key = (connId << 16) + nodeId;
    return getOrCreate(this.forwardingFeedback, key, () => ({ sum: 0 }));
  }
}
