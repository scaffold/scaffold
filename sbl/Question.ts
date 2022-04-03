import Context from './Context.ts';
import Hash from './util/Hash.ts';
import Answer from './Answer.ts';
import PublicationService from './PublicationService.ts';
import NodeService from './NodeService.ts';
import { getOrCreate } from './util/map.ts';
import { arrConcat } from './util/buffer.ts';
import { Node } from './NodeService.ts';

export default class Question {
  // Map from parent question hash to input
  public inputs: Map<string, { answerHash: Hash; incentive: bigint }> =
    new Map();

  // List of node hashes
  public subscriptions: Node[] = [];

  public answers: Answer[] = []; // In order of reception

  public isFulfilling = false;

  public canonicalCallbacks: ((answer: Answer) => void)[] = [];
  public canonicalAnswer?: Answer;

  // public expectedReward = 0n;

  constructor(
    public hash: Hash,
    public contractHash?: Hash,
    public params?: Uint8Array,
  ) {}

  public getContractHash() {
    return this.contractHash;
  }

  public getParams() {
    return this.params;
  }

  public addInput(questionHash: Hash, answerHash: Hash, incentive: bigint) {
    getOrCreate(
      this.inputs,
      questionHash.toHex(),
      () => ({ answerHash, incentive }),
      (prev) => incentive > prev.incentive ? { answerHash, incentive } : prev,
    );
  }

  public getTotalIncentive() {
    let total = 0n;
    this.inputs.forEach(({ incentive }) => total += incentive);
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
