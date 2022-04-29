import Context from './Context.ts';
import HashMap from './util/HashMap.ts';
import { HashExpr, QuestionSpec } from './messages.ts';
import { assert, error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import { arrConcat, arrEquals, fromNumber } from './util/buffer.ts';
import Answer from './Answer.ts';
import PublicationService from './PublicationService.ts';
import NodeService from './NodeService.ts';
import { getOrCreate } from './util/map.ts';
import { Node } from './NodeService.ts';
import { Connection } from './ConnectionService.ts';

export class Question {
  // Map from parent question hash to input
  // This is incentive that's already been "solidified" by an answer,
  //   while IncentiveService and this.selfIncentive is incentive that needs to be licensed by an answer.
  public incentives: Map<string, { answerHash: Hash; incentive: bigint }> =
    new Map();

  public selfIncentive = 0n;

  // public subscriptions: Node[] = [];

  public answers: Answer[] = []; // In order of reception

  public isFulfilling = false;

  public canonicalCallbacks: ((answer: Answer) => void)[] = [];
  public canonicalAnswer?: Answer;

  // public expectedReward = 0n;

  constructor(
    public spec: QuestionSpec,
    public hash: Hash,
    // public spec: QuestionSpec,
    // public hash: Hash,
    // public contractHash?: Hash,
    // public params?: Uint8Array,
  ) {}

  public addIncentive(
    parentQuestionHash: Hash,
    answerHash: Hash,
    incentive: bigint,
  ) {
    getOrCreate(
      this.incentives,
      parentQuestionHash.toHex(),
      () => ({ answerHash, incentive }),
      (prev) => incentive > prev.incentive ? { answerHash, incentive } : prev,
    );
  }

  public getTotalIncentive() {
    let total = this.selfIncentive;
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

export default class QuestionRegistry {
  private registry: Map<string, Question> = new Map();

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

  public static computeHash(spec: QuestionSpec) {
    const nonce = 0;

    // Gotta make sure here that modifying params can't create collisions
    return Hash.digest(
      arrConcat(
        spec.contract_answer_hash.toBytes(),
        fromNumber(nonce, 8),
        spec.params,
      ),
    );
  }

  constructor(private ctx: Context) {}

  public peek(hash: Hash) {
    return this.registry.get(hash.toHex());
  }

  public getOrCreate(spec: QuestionSpec) {
    const hash = QuestionRegistry.computeHash(spec);
    return getOrCreate(
      this.registry,
      hash.toHex(),
      () => new Question(spec, hash),
    );
  }
}
