import Context from './Context.ts';
import HashMap, { HashMapEntry } from './util/HashMap.ts';
import { HashExpr, QuestionSpec } from './messages.ts';
import Question from './Question.ts';
import { assert, error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import { arrConcat, arrEquals, fromNumber } from './util/buffer.ts';
import Answer from './Answer.ts';
import PublicationService from './PublicationService.ts';
import NodeService from './NodeService.ts';
import { getOrCreate } from './util/map.ts';
import { Node } from './NodeService.ts';

export class Question {
  // Map from parent question hash to input
  public incentives: Map<string, { answerHash: Hash; incentive: bigint }> =
    new Map();

  public subscriptions: Node[] = [];

  public answers: Answer[] = []; // In order of reception

  public isFulfilling = false;

  public canonicalCallbacks: ((answer: Answer) => void)[] = [];
  public canonicalAnswer?: Answer;

  // public expectedReward = 0n;

  constructor(
    public contractAnswerHash: Hash,
    public params: Uint8Array,
    // public spec: QuestionSpec,
    // public hash: Hash,
    // public contractHash?: Hash,
    // public params?: Uint8Array,
  ) {}

  public addIncentive(questionHash: Hash, answerHash: Hash, incentive: bigint) {
    getOrCreate(
      this.incentives,
      questionHash.toHex(),
      () => ({ answerHash, incentive }),
      (prev) => incentive > prev.incentive ? { answerHash, incentive } : prev,
    );
  }

  public getTotalIncentive() {
    let total = 0n;
    this.incentives.forEach(({ incentive }) => total += incentive);
    return total;
  }

  // public addSubscription(
  //   childQuestionHash: Hash,
  //   expectedReward: bigint,
  //   signedMsg: Uint8Array,
  //   nodeHash: Hash,
  // ) {
  //   getOrCreate(
  //     getOrCreate(
  //       this.subscriptions,
  //       childQuestionHash.toHex(),
  //       () => new Map(),
  //     ),
  //     nodeHash.toHex(),
  //     () => ({ expectedReward, signedMsg }),
  //     (
  //       commitment,
  //     ) => (expectedReward > commitment.expectedReward
  //       ? { expectedReward, signedMsg }
  //       : commitment),
  //   );

  //   let sumReward = 0n;
  //   this.subscriptions.forEach((commitments, childQuestionHex) => {
  //     let maxReward = 0n;
  //     commitments.forEach(({ expectedReward }, nodeHex) => {
  //       if (expectedReward > maxReward) maxReward = expectedReward;
  //     });
  //     sumReward += maxReward;
  //   });

  //   // TODO: We need to factor in how long the generation will take.
  //   this.expectedReward = sumReward;
  // }
}

export default class QuestionRegistry extends HashMap<Question> {
  // private static computeHash(spec: QuestionSpec): Hash {
  //   const nonce = 0;

  //   // Gotta make sure here that modifying params can't create collisions
  //   return Hash.digest(arrConcat(
  //     ('QuestionSpec' in spec.contract
  //       ? this.computeHash(spec.contract.QuestionSpec)
  //       : 'LoadContract' in spec.contract
  //       ? Hash.fromLiteral32(1)
  //       : 'CollateralContract' in spec.contract
  //       ? Hash.fromLiteral32(2)
  //       : 'DurationContract' in spec.contract
  //       ? Hash.fromLiteral32(3)
  //       : 'InputsContract' in spec.contract
  //       ? Hash.fromLiteral32(4)
  //       : error(`Don't know how to hash QuestionSpec ${JSON.stringify(spec)}`))
  //       .toBytes(),
  //     fromNumber(nonce, 8),
  //     spec.params,
  //   ));
  // }

  private static computeHash(contractAnswerHash: Hash, params: Uint8Array) {
    const nonce = 0;

    // Gotta make sure here that modifying params can't create collisions
    return Hash.digest(
      arrConcat(contractAnswerHash.toBytes(), fromNumber(nonce, 8), params),
    );
  }

  constructor(private ctx: Context) {
    super();
  }

  // public get(spec: QuestionSpec) {
  //   return this.getOrCreate(spec, () => new Question());
  // }

  public get(key: QuestionSpec) {
    return this.getOrCreate(
      QuestionRegistry.computeHash(key.contract_answer_hash, key.params),
      () => new Question(key.contract_answer_hash, key.params),
    );
  }
}

export type QuestionEntry = HashMapEntry<Question>;
