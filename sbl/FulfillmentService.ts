import secp from './util/secp.ts';
import Context from './Context.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import Hash from './util/Hash.ts';
import QuestionService from './QuestionService.ts';
import DhtService from './DhtService.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import SubscriptionService from './SubscriptionService.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import { PublishMessage } from './messages.ts';
import GraphUtils from './GraphUtils.ts';
import IncentiveService from './IncentiveService.ts';
import DurationPredictionService from './DurationPredictionService.ts';
import { SELF_CONNECTION } from './ConnectionService.ts';
import WorkerExecutor from './WorkerExecutor.ts';

const numParallelSubs = 8;
const secret = secp.utils.randomBytes(32);
const wasmMagic = new Uint8Array([0, 0x61, 0x73, 0x6D]);

export default class FulfillmentService {
  private attemptDupeFraction = Hash.fromFraction(1, 8);

  constructor(private ctx: Context) {}

  public fulfill(question: Question, stack: string[]) {
    question.isFulfilling = true;

    this.sendSubs(question, stack);

    this.launchExecutor(question, stack);
    // setTimeout(() => this.launchExecutor(question, stack), 0);
  }

  private sendSubs(question: Question, _stack: string[]) {
    for (let i = 0; i < numParallelSubs; i++) {
      // TODO
    }

    this.ctx.get(SubscriptionService).subscribe(question);
    // if (incentive > 0n) {
    //   this.ctx.get(IncentiveService).incentivize(question, incentive);
    // }
  }

  private launchExecutor(question: Question, stack: string[]) {
    const attemptCorrect = Hash.cmp(
      Hash.digest(
        arrConcat(secret, question.hash.toBytes()),
      ),
      this.attemptDupeFraction,
    ) === 1;

    const generators = this.ctx.get(QuestionRegistry).getOrCreate({
      contract_answer_hash:
        this.ctx.get(GraphUtils).getGeneratorContract().hash,
      params: question.spec.contract_answer_hash.toBytes(),
    }).answers;

    generators.forEach((gen) => {
      const onAnswer = (
        data: Uint8Array,
        inputs: Answer[],
        durationMs: number,
      ) => {
        const answer = this.ctx.get(AnswerRegistry).getOrCreate({
          question: {
            contract_answer_hash: question.spec.contract_answer_hash,
            params: question.spec.params,
          },
          inputs: inputs.map((answer) => answer.hash),
          answer: data,
          licenses: [],
          timestamp: BigInt(Date.now()),
        }, SELF_CONNECTION);
        answer.isCorrect = true;
        answer.difficultyEstimate = BigInt(durationMs) *
          this.ctx.config.approxComputePricePerSecond / 1000n;
        this.ctx.get(QuestionService).addAnswerToQuestion(answer);

        this.ctx.get(DurationPredictionService).learn(gen, durationMs);

        return answer;
      };

      const script = eval(new TextDecoder().decode(gen.data));
      if (typeof script === 'object') {
        const emitCorrect = true;
        const { cancel, result, hasDirtyInputs } = this.ctx.get(WorkerExecutor)
          .run(script, {
            contractHash: question.spec.contract_answer_hash.toBytes(),
            params: question.spec.params,
            emitCorrect: new Uint8Array([emitCorrect ? 1 : 0]),
          }, { answer: null });
        result.then((out) => console.log('DONE', out));
        result.then(({ outputs: { answer: data }, usedAnswers }) => {
          const _answer = onAnswer(data, [...usedAnswers], 0);
          hasDirtyInputs.then(() => {});
        });
      } else if (typeof script === 'function') {
        callWithSyncRequestHandler<Uint8Array>(
          this.ctx,
          question,
          (handler, notifier) =>
            script(
              question.spec.contract_answer_hash,
              question.spec.params,
              true,
              handler,
              notifier,
            ),
          onAnswer,
          stack,
        );
      } else {
        throw new Error(`Invalid script type: ${typeof script}`);
      }
    });
  }
}
