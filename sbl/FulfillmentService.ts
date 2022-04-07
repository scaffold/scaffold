import secp from './util/secp.ts';
import Context from './Context.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import Hash from './util/Hash.ts';
import QuestionService from './QuestionService.ts';
import DhtService from './DhtService.ts';
import { arrConcat } from './util/buffer.ts';
import SubscriptionService from './SubscriptionService.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import QuestionRegistry, { QuestionEntry } from './QuestionRegistry.ts';
import { PublishMessage } from './messages.ts';

const numParallelSubs = 8;
const secret = secp.utils.randomBytes(32);

export default class FulfillmentService {
  private attemptDupeFraction = Hash.fromFraction(1, 8);

  constructor(private ctx: Context) {}

  public fulfill(entry: QuestionEntry) {
    entry.val.isFulfilling = true;
    this.sendSubs(entry);
    this.launchExecutor(entry);
  }

  private sendSubs(entry: QuestionEntry) {
    for (let i = 0; i < numParallelSubs; i++) {
      // TODO
    }

    this.ctx.get(SubscriptionService).subscribe(entry);
  }

  private launchExecutor(entry: QuestionEntry) {
    const attemptCorrect = Hash.cmp(
      Hash.digest(
        arrConcat(secret, entry.hash.toBytes()),
      ),
      this.attemptDupeFraction,
    ) === 1;

    const gen = this.ctx.config.generators.find(
      (g) =>
        Hash.equals(g.contractHash, entry.val.contractAnswerHash) &&
        g.isCorrect === attemptCorrect,
    );
    if (gen) {
      callWithSyncRequestHandler(
        this.ctx,
        (handler) => gen.func(entry.val.params!, handler),
        (data) => {
          const publication: PublishMessage = {
            question: entry.val.question,
            inputs: [],
            answer: data,
            licenses: [],
            timestamp: BigInt(Date.now()),
          };

          const { val: answer } = this.ctx.get(AnswerRegistry).get(publication);
          answer.isCorrect = attemptCorrect;
          this.ctx.get(QuestionService).addAnswer(answer.question, answer);
        },
      );
    }
  }
}
