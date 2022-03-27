import Context from './Context.ts';
import Hash from './util/Hash.ts';
import Answer from './Answer.ts';
import PublicationService from './PublicationService.ts';
import NodeService from './NodeService.ts';
import { getOrCreate } from './util/map.ts';

export default class Question {
  // Map from child question hash to map from node hash to commitment.
  public subscriptions: Map<
    string,
    Map<string, {
      expectedReward: bigint;
      signature: Uint8Array;
      msgData: Uint8Array;
    }>
  > = new Map();

  private answers: Answer[] = []; // In most likely order of network acceptance; typically order of reception

  private isFulfilling = false;

  public expectedReward = 0n;

  constructor(
    private ctx: Context,
    // These could potentially be optional in the future
    private contractHash: Hash,
    private params: Uint8Array,
  ) {}

  public getContractHash() {
    return this.contractHash;
  }

  public getParams() {
    return this.params;
  }

  public addSubscription(
    childQuestionHash: Hash,
    expectedReward: bigint,
    signedMsg: Uint8Array,
    nodeHash: Hash,
  ) {
    getOrCreate(
      getOrCreate(
        this.subscriptions,
        childQuestionHash.toHex(),
        () => new Map(),
      ),
      nodeHash.toHex(),
      () => ({ expectedReward, signedMsg }),
      (
        commitment,
      ) => (expectedReward > commitment.expectedReward
        ? { expectedReward, signedMsg }
        : commitment),
    );

    let sumReward = 0n;
    this.subscriptions.forEach((commitments, childQuestionHex) => {
      let maxReward = 0n;
      commitments.forEach(({ expectedReward }, nodeHex) => {
        if (expectedReward > maxReward) maxReward = expectedReward;
      });
      sumReward += maxReward;
    });

    // TODO: We need to factor in how long the generation will take.
    this.expectedReward = sumReward;
  }

  public addAnswer(answer: Answer) {
    this.answers.push(answer);

    if (!answer.data) {
      throw new Error(`Not sure what causes this case`);
    }

    const contractHash = this.getContractHash();
    const params = this.getParams();

    this.subscriptions.forEach((commitments, childQuestionHex) =>
      commitments.forEach((subscription, nodeHex) => {
        const node = this.ctx.get(NodeService).lookup(Hash.fromHex(nodeHex));
        this.ctx.get(PublicationService).publish(node, answer);
      })
    );

    // if (answer.timestamp) {
    //   this.set(
    //     hashes.timeHash,
    //     Hash.digest(arrConcat(contractHash.toBytes(), params)).toBytes(),
    //     { data: fromNumber(Number(answer.timestamp), 8) },
    //   );
    // }

    // if (
    //   !this.canonicalAnswer ||
    //   answer.canonicalScore > this.canonicalAnswer.canonicalScore
    // ) {
    //   this.canonicalAnswer = answer;
    //   this.canonicalCallbacks.forEach((cb) => cb(answer));
    // }
  }
}
