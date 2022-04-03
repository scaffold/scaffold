import secp from './util/secp.ts';
import Context from './Context.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import Hash from './util/Hash.ts';
import QuestionService from './QuestionService.ts';
import DhtService from './DhtService.ts';
import { arrConcat } from './util/buffer.ts';
import SubscriptionService from './SubscriptionService.ts';
import Answer from './Answer.ts';
import Question from './Question.ts';

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
      const entry = this.ctx.get(DhtService).getClosestEntry(question.hash);
      if (entry) {
        this.ctx.get(SubscriptionService).subscribe(
          entry.node,
          question.contractHash,
          question.params,
          question.hash,
        );
      }
    }
  }

  private launchExecutor(question: Question) {
    const attemptCorrect = Hash.cmp(
      Hash.digest(
        arrConcat(secret, question.hash.toBytes()),
      ),
      this.attemptDupeFraction,
    ) === 1;

    const gen = this.ctx.config.generators.find(
      (g) =>
        Hash.equals(g.contractHash, question.contractHash) &&
        g.isCorrect === attemptCorrect,
    );
    if (gen) {
      callWithSyncRequestHandler(
        this.ctx,
        (handler) => gen.func(question.params, handler),
        (data) => {
          const answer = new Answer(question, data);
          answer.isCorrect = attemptCorrect;
          this.ctx.get(QuestionService).addAnswer(question, answer);
        },
      );
    }
  }
}
