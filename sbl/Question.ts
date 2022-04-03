import Context from './Context.ts';
import Hash from './util/Hash.ts';
import Answer from './Answer.ts';
import PublicationService from './PublicationService.ts';
import NodeService from './NodeService.ts';
import { getOrCreate } from './util/map.ts';
import { arrConcat } from './util/buffer.ts';

export default class Question {
  public hash: Hash;

  // Map from parent question hash to input
  public inputs: Map<string, { answerHash: Hash; incentive: bigint }> =
    new Map();

  // List of node hashes
  public subscriptions: Hash[];

  public answers: Answer[] = []; // In order of reception

  public isFulfilling = false;

  // public expectedReward = 0n;

  constructor(
    // These could potentially be optional in the future
    public contractHash: Hash,
    public params: Uint8Array,
  ) {
    this.hash = Hash.digest(arrConcat(contractHash.toBytes(), params));
  }

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
