import Context from './Context.ts';
import QuestionService from './QuestionService.ts';
import { Question } from './QuestionRegistry.ts';
import { Answer } from './AnswerRegistry.ts';
import Hash from './util/Hash.ts';
import DifficultyPredictionService from './DifficultyPredictionService.ts';

const noAnswerSentinel = Symbol('noAnswerSentinel');

class NeedsMoreDataError extends Error {
  constructor() {
    super();
  }
}

const callWithSyncRequestHandler = async <T>(
  ctx: Context,
  question: Question,
  func: (
    handler: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    notifier: (contractHash: Hash, params: Uint8Array) => void,
  ) => T | Promise<T>,
  onAnswer: (answer: T, inputs: Answer[], durationMs: number) => void,
  stack: string[],
) => {
  const requests: Map<
    string,
    { question: Question; incentivize(amount: bigint): void }
  > = new Map();

  try {
    const inputs: Answer[] = [];
    const startTime = Date.now();
    const out = await func((contractHash: Hash, params: Uint8Array) => {
      let answer: Answer | typeof noAnswerSentinel = noAnswerSentinel;

      let inside = true;
      const req = ctx.get(QuestionService).getCanonical({
        contract_answer_hash: contractHash,
        params,
      }, stack);
      req.onAnswer((a: Answer) => {
        if (inside) {
          answer = a;
        } else {
          callWithSyncRequestHandler(ctx, question, func, onAnswer, stack);
        }
      });
      inside = false;

      if (answer !== noAnswerSentinel) {
        inputs.push(answer);
        return (answer as Answer).data;
      } else {
        // No answers
        requests.set(req.question.hash.toHex(), req);
        throw new NeedsMoreDataError();
      }
    }, (contractHash: Hash, params: Uint8Array) => {
      const req = ctx.get(QuestionService).getCanonical({
        contract_answer_hash: contractHash,
        params,
      }, stack);
      if (req.question.canonicalAnswer) {
        // TODO: If the canonical answer was incentivized by this request, we should decrement the remaining incentive.
        // if (req.question.canonicalAnswer.inputs.some(input => Hash.equals(input,)))
      } else {
        requests.set(req.question.hash.toHex(), req);
      }
    });

    onAnswer(out, inputs, Date.now() - startTime);
  } catch (err) {
    if (err instanceof NeedsMoreDataError) {
      // Needs more data.
      // When data arrives (calling req.onAnswer), this function will be called again.
      // In the meantime, we should incentivize the answers we don't have.
      const difficulties: bigint[] = [];
      requests.forEach((req, _key) =>
        difficulties.push(
          ctx.get(DifficultyPredictionService).predict(req.question),
        )
      );
      const totalDifficulty = difficulties.reduce(
        (acc, diff) => acc + diff,
        // Initialize difficulty with question's difficulty to "leave" some incentive to it.
        ctx.get(DifficultyPredictionService).predict(question),
      );
      const totalIncentive = question.getTotalIncentive();
      let i = 0;
      requests.forEach((req, _key) =>
        req.incentivize(totalIncentive * difficulties[i++] / totalDifficulty)
      );
    } else {
      throw err;
    }
  }
};

export default callWithSyncRequestHandler;
