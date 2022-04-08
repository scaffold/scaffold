import Context from './Context.ts';
import QuestionService from './QuestionService.ts';
import Hash from './util/Hash.ts';
import { Connection } from './ConnectionService.ts';
import { error } from './util/functional.ts';
import PublicationService from './PublicationService.ts';
import { Node } from './NodeService.ts';
import { SubscribeMessage } from './messages.ts';
import MessageCtx from './MessageCtx.ts';
import FulfillmentService from './FulfillmentService.ts';
import DhtService from './DhtService.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';

export default class SubscriptionService {
  constructor(private ctx: Context) {}

  public subscribe(question: Question) {
    if (!question.contractAnswerHash || !question.params) {
      throw new Error(`Question doesn't have contractAnswerHash or params`);
    }

    const dhtEntry = this.ctx.get(DhtService).getClosestEntry(question.hash);
    if (dhtEntry) {
      dhtEntry.node.defaultConn?.sendReliable({
        SubscribeMessage: {
          question: {
            contract_answer_hash: question.contractAnswerHash,
            params: question.params,
          },
        },
      });
    }
  }

  public handleSubscribeMessage(msgCtx: MessageCtx, msg: SubscribeMessage) {
    this.ctx.get(QuestionRegistry).getBySpec(msg.question).subscriptions.push(
      msgCtx.conn.node,
    );

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
