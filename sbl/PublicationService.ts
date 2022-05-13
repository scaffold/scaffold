import EnvoyContract from '~/graph/EnvoyContract.ts';
import * as envoyMessages from '~/graph/envoyMessages.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import Context from './Context.ts';
import IncentiveService from './IncentiveService.ts';
import MessageCtx from './MessageCtx.ts';
import { Packet, PublishMessage, QuestionSpec } from './messages.ts';
import { Node } from './NodeService.ts';
import RewardSpec from './RewardSpec.ts';
import { arrEquals } from './util/buffer.ts';
import { assert } from './util/functional.ts';
import Hash from './util/Hash.ts';

const questionEquals = (q1: QuestionSpec, q2: QuestionSpec) =>
  Hash.equals(q1.contract_answer_hash, q2.contract_answer_hash) &&
  arrEquals(q1.params, q2.params);

export default class PublicationService {
  private envoyContractHash: Hash;

  constructor(private ctx: Context) {
    this.envoyContractHash = this.ctx.get(EnvoyContract).get().hash;
  }

  public publish(node: Node, answer: Answer) {
    // TODO: Get this removed (0)
    if (!answer.computation) {
      return;
    }

    if (answer.isCorrect !== true) {
      throw new Error(`Can't publish an answer that we don't know to be true`);
    }
    if (answer.difficultyEstimate === undefined) {
      throw new Error(`Can't publish an answer that we didn't calculate`);
    }

    // const licenses: License[] = [];
    // answer.question.subscriptions.forEach((commitments, childQuestionHex) =>
    //   commitments.forEach(({ signature, msgData }, nodeHex) => {
    //     licenses.push({ signature, subscribe_msg: msgData });
    //   })
    // );

    let inputIncentive = 0n;
    for (const hash of answer.inputs) {
      const inputAnswer = this.ctx.get(AnswerRegistry).peek(hash)!;
      assert(Hash.equals(hash, inputAnswer.hash));
      const license = inputAnswer.licenses.find(
        (license) =>
          Hash.equals(
            license.question.contract_answer_hash,
            answer.question.spec.contract_answer_hash,
          ) && arrEquals(license.question.params, answer.question.spec.params),
      );
      if (license) {
        inputIncentive += license.incentive;
      }
    }

    const inputs = [...answer.inputs];

    for (const [_, { answerHash, incentive }] of answer.question.incentives) {
      inputs.push(answerHash);
      inputIncentive += incentive;
    }

    const licenses = this.ctx
      .get(IncentiveService)
      .popIncentives(inputIncentive)
      .map(({ question, incentive }) => ({
        question: question.spec,
        incentive,
      }));

    node.defaultConn?.sendReliable({
      PublishMessage: {
        question: answer.question.spec,
        inputs,
        answer: answer.data!,
        licenses,
        timestamp: this.now(),
      },
    });
  }

  public handlePublishMessage(msgCtx: MessageCtx, msg: PublishMessage) {
    if (!this.verifyTimestamp(msg)) {
      console.log(`Timestamp does not verfiy`);
      return;
    }

    const inputIncentive = msg.inputs.reduce((acc, inputHash) => {
      const inputAnswer = this.ctx.get(AnswerRegistry).peek(inputHash);
      if (!inputAnswer) {
        throw new Error(
          `Cannot verify message because input ${inputHash.toHex()} is unknown`,
        );
      }
      const foundIncentive = inputAnswer.licenses.find((license) =>
        questionEquals(license.question, msg.question)
      );
      return foundIncentive ? acc + foundIncentive.incentive : acc;
    }, this.ctx.get(RewardSpec).getReward(msg.question));

    if (msg.licenses.some((license) => license.incentive < 0)) {
      console.log(
        `Received publication where license incentive is negative; discarding.`,
      );
      return;
    }
    if (
      msg.licenses.reduce((acc, { incentive }) => acc + incentive, 0n) !==
        inputIncentive
    ) {
      console.log(
        `Received publication where license incentive sum does not equal input incentive sum; discarding.`,
      );
      return;
    }

    const _answer = this.ctx.get(AnswerRegistry).getOrCreate(msg, msgCtx.conn);

    console.log(`TODO: Need to possibly execute contract here`);
    console.log(
      `TODO: Need to forward the publication to the appropriate DHT entry`,
    );

    if (
      Hash.equals(msg.question.contract_answer_hash, this.envoyContractHash)
    ) {
      this.handlePublishMessage(
        msgCtx,
        envoyMessages.Answer.decode(msg.answer).publication,
      );
    }

    // this.ctx.get(ActionExecutor).addAction({ type: 'verify', answer });

    /*
    const contract = this.ctx.config.contracts.find((c) =>
      Hash.equals(c.hash, msg.question.contract_answer_hash)
    );
    if (contract) {
      callWithSyncRequestHandler(
        this.ctx,
        (handler) => contract.func(msg.question.params, answer.data, handler),
        (isCorrect) => {
          // TODO: Publish collateral here

          console.log(
            `Received publication is ${isCorrect ? 'CORRECT' : 'INCORRECT'}`,
          );
        },
      );
    }
    */

    // if (this.ctx.config.shouldVerify(this.ctx, fromPeer, pub)) {
    //   const contract = this.ctx.config.contracts.find(
    //     (c) => c.name === pub.contractName
    //   );
    //   if (contract) {
    //     callWithSyncRequestHandler(
    //       this.ctx,
    //       (handler: (contractName: string, params: any) => any) =>
    //         contract.func(pub.params, pub.answer, handler),
    //       (contractOut: boolean) => {
    //         if (fromPeer === this.ctx.config.selfId) {
    //           if (contractOut !== pub._isCorrect) {
    //             throw new Error(
    //               `${
    //                 contractOut ? 'Correct' : 'Incorrect'
    //               } answer for contract ${
    //                 contract.name
    //               } and params ${JSON.stringify(pub.params)}: ${JSON.stringify(
    //                 pub.answer
    //               )}`
    //             );
    //           }
    //         } else {
    //           this.ctx
    //             .get(Db)
    //             .query(
    //               'INSERT INTO posted_collateral (peer_id, answer_hash, judgement, amount) VALUES (?, ?, ?, ?)',
    //               [
    //                 fromPeer.id,
    //                 (await Hash.digest('abc')).toHex(),
    //                 contractOut,
    //                 this.ctx.config.peerJudgementCollateral,
    //               ]
    //             );

    //           // TODO: Send to peers and add peers' collateral posts into my table
    //         }
    //       }
    //     );
    //   }
    // }
  }

  private verifyTimestamp(publication: PublishMessage) {
    // Parent timestamps < Epoch N * C < timestamp < peer time()
    // Perhaps only nodes with proof of work can send these, to prevent flooding. Reduce trust for nodes who send timestamps in the future.

    // TODO: Verify parent_timestamps < contract_min_timestamp_if_any < timestamp
    return publication.timestamp <= this.now();
  }

  private now() {
    return BigInt(Date.now());
  }
}
