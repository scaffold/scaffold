import secp from './util/secp.ts';
import Context from './Context.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import Hash from './util/Hash.ts';
import QuestionService from './QuestionService.ts';
import DhtService from './DhtService.ts';
import { arrConcat } from './util/buffer.ts';
import SubscriptionService from './SubscriptionService.ts';
import Answer from './Answer.ts';

const numParallelSubs = 8;
const secret = secp.utils.randomBytes(32);

export default class FulfillmentService {
  private attemptDupeFraction = Hash.fromFraction(1, 8);

  constructor(private ctx: Context) {}

  public fulfill(contractHash: Hash, params: Uint8Array) {
    this.sendSubs(contractHash, params);
    this.launchExecutor(contractHash, params);
  }

  private sendSubs(contractHash: Hash, params: Uint8Array) {
    for (let i = 0; i < numParallelSubs; i++) {
      const dst = this.ctx.get(QuestionService).computeQuestionHash(
        contractHash,
        params,
        i,
      );
      const entry = this.ctx.get(DhtService).getClosestEntry(dst);
      if (entry) {
        this.ctx.get(SubscriptionService).subscribe(
          entry.node,
          contractHash,
          params,
          dst,
        );
      }
    }
  }

  private launchExecutor(contractHash: Hash, params: Uint8Array) {
    const attemptCorrect = Hash.cmp(
      Hash.digest(
        arrConcat(secret, contractHash.toBytes(), params),
      ),
      this.attemptDupeFraction,
    ) === 1;

    const gen = this.ctx.config.generators.find(
      (g) =>
        Hash.equals(g.contractHash, contractHash) &&
        g.isCorrect === attemptCorrect,
    );
    if (gen) {
      callWithSyncRequestHandler(
        this.ctx,
        (handler) => gen.func(params, handler),
        (data) => {
          const qs = this.ctx.get(QuestionService);
          const questionHash = qs.computeQuestionHash(contractHash, params);
          const answer = new Answer(data);
          answer.isCorrect = attemptCorrect;
          qs.getQuestion(questionHash).addAnswer(answer);
        },
      );
    }
  }
}
