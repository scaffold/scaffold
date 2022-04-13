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

const callWithSyncRequestHandler = async <T>(
  ctx: Context,
  func: (
    handler: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    notifier: (contractHash: Hash, params: Uint8Array) => void,
  ) => T | Promise<T>,
  onAnswer: (answer: T, inputs: Answer[], durationMs: number) => void,
  recursionLimit: number,
  stack: string[],
) => {
  // console.log('cwsrh');
  try {
    const inputs: Answer[] = [];
    const startTime = Date.now();
    const out = await func((contractHash: Hash, params: Uint8Array) => {
      let answer: Answer | typeof noAnswerSentinel = noAnswerSentinel;

      let inside = true;
      // console.log('gc');
      ctx.get(QuestionService).getCanonical(
        {
          contract_answer_hash: contractHash,
          params,
        },
        (a: Answer) => {
          // console.log('ga', inside);
          if (inside) {
            answer = a;
          } else {
            callWithSyncRequestHandler(
              ctx,
              func,
              onAnswer,
              recursionLimit,
              stack,
            );
          }
        },
        recursionLimit - 1,
        stack,
      );
      inside = false;

      if (answer !== noAnswerSentinel) {
        inputs.push(answer);
        // console.log('in');
        return (answer as Answer).data;
      } else {
        // No answers
        throw new NeedsMoreDataError();
      }
    }, (contractHash: Hash, params: Uint8Array) => {
      // TODO: Notify of interest
      throw new Error(`TODO: Notify of interest`);
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
