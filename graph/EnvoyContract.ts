import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import { QuestionSpec } from '~/sbl/messages.ts';
import { Answer } from '~/sbl/AnswerRegistry.ts';
import * as envoyMessages from './envoyMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import QuestionService from '~/sbl/QuestionService.ts';

export default class EnvoyContract {
  constructor(private ctx: Context) {}

  public get() {
    const envoyFetchAnswer = (question: QuestionSpec) => {
      let outerAnswer: Answer | undefined;
      this.ctx.get(QuestionService).getCanonical(question)
        .onAnswer((answer) => outerAnswer = answer)
        .release();
      return outerAnswer!;
    };

    const envoyGenerator = (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      const { question } = envoyMessages.Params.decode(params);

      // Use this to block until a new answer becomes available,
      const data = request(question.contract_answer_hash, question.params);

      // Then fetch the entire answer (not just the data portion).
      const answer = envoyFetchAnswer(question);

      if (!arrEquals(answer.data, data)) {
        throw new Error(`Answer data doesn't match`);
      }

      return envoyMessages.Answer.encode({
        publication: {
          question,
          inputs: answer.inputs,
          answer: data,
          licenses: answer.licenses,
          timestamp: answer.timestamp,
        },
      });
    };

    const envoyContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      // Just run the generator and check it equals the candidate answer.
      arrEquals(
        envoyGenerator(contractHash, params, true, request),
        request(contractHash, params),
      );

    // This is a nasty hack until we get WASM working
    (window as any).envoyGenerator = envoyGenerator;
    (window as any).envoyMessages = envoyMessages;
    (window as any).envoyFetchAnswer = envoyFetchAnswer;

    const contract = this.ctx.get(GraphUtils).supplyContract(envoyContract);
    this.ctx.get(GraphUtils).supplyGenerator(contract, envoyGenerator);

    return contract;
  }
}
