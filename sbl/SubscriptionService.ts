import Context from './Context.ts';
import { SubscribeMessage, Verifier } from './messages.ts';
import NodeService from './NodeService.ts';
// import DhtService from './DhtService.ts';

export default class SubscriptionService {
  constructor(private ctx: Context) {}

  public subscribe(verifier: Verifier) {
    this.ctx.get(NodeService).getAll().forEach((node) =>
      node.defaultConn?.sendReliable({ SubscribeMessage: { verifier } })
    );
    // const dhtEntry = this.ctx.get(DhtService).getClosestEntry(question.hash);
    // if (dhtEntry) {
    //   dhtEntry.node.defaultConn?.sendReliable({
    //     SubscribeMessage: { question: question.spec },
    //   });
    // }
  }

  // public handleSubscribeMessage(msgCtx: MessageCtx, msg: SubscribeMessage) {
  //   // this.ctx.get(QuestionRegistry).getBySpec(msg.question).subscriptions.push(
  //   //   msgCtx.conn.node,
  //   // );

  //   this.ctx.get(QuestionService).getCanonical(msg.question).onAnswer((
  //     answer: Answer,
  //   ) => this.ctx.get(PublicationService).publish(msgCtx.conn.node, answer));
  // }
}
