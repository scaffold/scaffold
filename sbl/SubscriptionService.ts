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

export default class SubscriptionService {
  constructor(private ctx: Context) {}

  public subscribe(
    node: Node,
    contractHash: Hash,
    params: Uint8Array,
    destination: Hash,
  ) {
    node.defaultConn?.sendReliable({
      SubscribeMessage: {
        question: { contract: null, contract_hash: contractHash, params },
        destination,
      },
    });
  }

  public handleSubscribeMessage(msgCtx: MessageCtx, msg: SubscribeMessage) {
    const qs = this.ctx.get(QuestionService);

    const questionHash = qs.computeQuestionHash(
      msg.question.contract_hash,
      msg.question.params,
    );
    const question = qs.getQuestion(questionHash);
    question.addSubscription(
      questionHash,
      msg.expected_reward,
      msgCtx.signedMsg,
      msgCtx.conn.node.hash,
    );

    // TODO: Test question.expectedReward better
    if (question.expectedReward) {
      this.ctx.get(FulfillmentService).fulfill(
        msg.question.contract_hash,
        msg.question.params,
      );
    }

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
