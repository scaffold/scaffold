import Context from './Context.ts';
import QuestionService, { Answer } from './QuestionService.ts';
import Hash from './util/Hash.ts';
import { Connection } from './ConnectionService.ts';
import { error } from './util/functional.ts';
import PublicationService from './PublicationService.ts';
import { Node } from './NodeService.ts';
import { SubscribeMessage } from './messages.ts';
import MessageCtx from './MessageCtx.ts';
import FulfillmentService from './FulfillmentService.ts';
import DhtService from './DhtService.ts';
import Question from './Question.ts';

export default class SubscriptionService {
  constructor(private ctx: Context) {}

  public subscribe(question: Question) {
    const entry = this.ctx.get(DhtService).getClosestEntry(question.hash);
    if (entry) {
      entry.node.defaultConn?.sendReliable({
        SubscribeMessage: {
          question_hash: question.hash,
        },
      });
    }
  }

  public handleSubscribeMessage(msgCtx: MessageCtx, msg: SubscribeMessage) {
    this.ctx.get(QuestionService).getQuestion(msg.question_hash).subscriptions
      .push(msgCtx.conn.node);
    // this.ctx
    //   .get(QuestionService)
    //   .getCanonical(
    //     msg.question.contract_hash,
    //     msg.question.params,
    //     (answer: Answer) =>
    //       this.ctx.get(PublicationService).publish(
    //         conn.node,
    //         msg.question.contract_hash,
    //         msg.question.params,
    //         answer.data,
    //       ),
    //   );
  }
}
