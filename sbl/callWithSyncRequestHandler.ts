import Context from './Context.ts';
import QuestionService from './QuestionService.ts';
import { Answer } from './AnswerRegistry.ts';
import Hash from './util/Hash.ts';

const noAnswerSentinel = Symbol('noAnswerSentinel');

class NeedsMoreDataError extends Error {
  constructor() {
    super();
  }
}

const callWithSyncRequestHandler = <T>(
  ctx: Context,
  func: (handler: (contractHash: Hash, params: Uint8Array) => Uint8Array) => T,
  onAnswer: (answer: T, inputs: Answer[], durationMs: number) => void,
) => {
  // console.log('cwsrh');
  try {
    const inputs: Answer[] = [];
    const startTime = Date.now();
    const out = func((contractHash: Hash, params: Uint8Array) => {
      let answer: Answer | typeof noAnswerSentinel = noAnswerSentinel;

      let inside = true;
      // console.log('gc');
      ctx.get(QuestionService).getCanonical({
        contract_answer_hash: contractHash,
        params,
      }, (a: Answer) => {
        // console.log('ga', inside);
        if (inside) {
          answer = a;
        } else {
          callWithSyncRequestHandler(ctx, func, onAnswer);
        }
      });
      inside = false;

      if (answer !== noAnswerSentinel) {
        inputs.push(answer);
        // console.log('in');
        return (answer as Answer).data;
      } else {
        // No answers
        throw new NeedsMoreDataError();
      }
    });

    // console.log('oa');
    onAnswer(out, inputs, Date.now() - startTime);
  } catch (err) {
    if (err instanceof NeedsMoreDataError) {
      // Needs more data
    } else {
      throw err;
    }
  }
};

export default callWithSyncRequestHandler;
