import Context from './Context.ts';
import QuestionService from './QuestionService.ts';
import AnswerService from './AnswerService.ts';
import { Connection } from './ConnectionService.ts';
import { error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import { Node } from './NodeService.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import { License, PublishMessage } from './messages.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import QuestionRegistry from './QuestionRegistry.ts';
import MessageCtx from './MessageCtx.ts';
import IncentiveService from './IncentiveService.ts';
import { assert } from './util/functional.ts';
import RewardSpec from './RewardSpec.ts';
import EnvoyContract from '~/graph/EnvoyContract.ts';
import * as envoyMessages from '~/graph/envoyMessages.ts';

export default class PublicationService {
  private envoyContractHash: Hash;

  constructor(private ctx: Context) {
    this.envoyContractHash = this.ctx.get(EnvoyContract).get().hash;
  }

  public publish(node: Node, answer: Answer) {
    if (answer.isCorrect !== true) {
      return;
    }

    if (!answer.data) {
      throw new Error(`Not sure what causes this case`);
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
      const license = inputAnswer.licenses.find((license) =>
        Hash.equals(license.question_hash, answer.question.hash)
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

    const licenses = answer.licenses.length ? answer.licenses : (() => {
      const selfIncentive = answer.difficultyEstimate < inputIncentive
        ? answer.difficultyEstimate
        : inputIncentive;
      const remainingIncentive = inputIncentive - selfIncentive;

      const licenses = this.ctx.get(IncentiveService).popIncentives(
        selfIncentive,
      )
        .map(({ question, incentive }) => ({
          question_hash: question.hash,
          incentive,
        }));

      // TODO: Who to incentivize here? The epoch?
      // This is bad, but just put it towards a random question.
      licenses.push({
        question_hash: Hash.random(),
        incentive: remainingIncentive,
      });

      return licenses;
    })();

    node.defaultConn?.sendReliable({
      PublishMessage: {
        question: {
          contract_answer_hash: answer.question.contractAnswerHash!,
          params: answer.question.params!,
        },
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

    // TODO: Check inputs
    if (msg.inputs.length) {
      throw new Error(`TODO: Check inputs`);
    }
    // const inputs = msg.inputs.map((input) => this.ctx.get(AnswerRegistry).peek(input));
    // inputs.reduce((acc, answer)=>acc + answer., 0n);
    const inputIncentive = this.ctx.get(RewardSpec).getReward(msg.question);

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

    const answer = this.ctx.get(AnswerRegistry).getByPub(msg);
    this.ctx.get(QuestionService).addAnswerToQuestion(answer);

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
