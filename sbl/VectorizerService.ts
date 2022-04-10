import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { Question } from './QuestionRegistry.ts';

export default class VectorizerService {
  private vectorizers: Map<string, (params: Uint8Array) => number[]> =
    new Map();

  constructor(private ctx: Context) {}

  public register(
    contractHash: Hash,
    vectorizer: (params: Uint8Array) => number[],
  ) {
    const key = contractHash.toHex();
    if (this.vectorizers.has(key)) {
      throw new Error(`Duplicate vectorizer for contract ${key}`);
    }
    this.vectorizers.set(key, vectorizer);
  }

  public vectorize(question: Question) {
    if (question.contractAnswerHash && question.params) {
      const vectorizer = this.vectorizers.get(
        question.contractAnswerHash.toHex(),
      );
      if (vectorizer) {
        return vectorizer(question.params);
      }
    }
    return [];
  }
}
