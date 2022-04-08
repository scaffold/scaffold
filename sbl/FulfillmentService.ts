import secp from './util/secp.ts';
import Context from './Context.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import Hash from './util/Hash.ts';
import QuestionService from './QuestionService.ts';
import DhtService from './DhtService.ts';
import { arrConcat } from './util/buffer.ts';
import SubscriptionService from './SubscriptionService.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import { PublishMessage } from './messages.ts';

const numParallelSubs = 8;
const secret = secp.utils.randomBytes(32);

export default class FulfillmentService {
  private attemptDupeFraction = Hash.fromFraction(1, 8);

  constructor(private ctx: Context) {}

  public fulfill(question: Question) {
    question.isFulfilling = true;
    this.sendSubs(question);
    this.launchExecutor(question);
  }

  private sendSubs(question: Question) {
    for (let i = 0; i < numParallelSubs; i++) {
      // TODO
    }

    this.ctx.get(SubscriptionService).subscribe(question);
  }

  private launchExecutor(question: Question) {
    if (!question.contractAnswerHash || !question.params) {
      throw new Error(
        `Cannot generate if we don't know the contract hash or params`,
      );
    }

    const attemptCorrect = Hash.cmp(
      Hash.digest(
        arrConcat(secret, question.hash.toBytes()),
      ),
      this.attemptDupeFraction,
    ) === 1;

    const gen = this.ctx.config.generators.find(
      (g) =>
        Hash.equals(g.contractHash, question.contractAnswerHash!) &&
        g.isCorrect === attemptCorrect,
    );
    if (gen) {
      callWithSyncRequestHandler(
        this.ctx,
        (handler) => gen.func(question.params!, handler),
        (data) => {
          const publication: PublishMessage = {
            question: {
              contract_answer_hash: question.contractAnswerHash!,
              params: question.params!,
            },
            inputs: [],
            answer: data,
            licenses: [],
            timestamp: BigInt(Date.now()),
          };

          // TODO: Working here
          throw new Error(`TODO: Working here`);

          // const answer = this.ctx.get(AnswerRegistry).get(publication);
          // answer.isCorrect = attemptCorrect;
          // this.ctx.get(QuestionService).addAnswer(answer.question, answer);
        },
      );
    }
  }
}
