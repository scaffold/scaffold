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

export default class PublicationService {
  constructor(private ctx: Context) {}

  public publish(
    node: Node,
    answer: Answer,
  ) {
    if (!answer.data) {
      throw new Error(`Not sure what causes this case`);
    }

    const licenses: License[] = [];
    answer.question.subscriptions.forEach((commitments, childQuestionHex) =>
      commitments.forEach(({ signature, msgData }, nodeHex) => {
        licenses.push({ signature, subscribe_msg: msgData });
      })
    );

    node.defaultConn?.sendReliable({
      PublishMessage: {
        question: {
          contract: null,
          contract_hash: answer.question.getContractHash(),
          params: answer.question.getParams(),
        },
        inputs: [],
        answer: answer.data!,
        licenses,
        timestamp: this.now(),
      },
    });
  }

  public handlePublishMessage(conn: Connection, msg: PublishMessage) {
    if (!this.verifyTimestamp(msg)) {
      console.log(`Timestamp does not verfiy`);
      return;
    }

    const inputs = msg.inputs.map((input) => this.ctx.get(AnswerRegistry).peek(input));
    inputs.reduce((acc, answer)=>acc + answer., 0n);



    if (msg.licenses.some((license) => license.incentive < 0)) {
      console.log(`An incentive is negative`);
      return;
    }

    const answer = this.ctx.get(AnswerRegistry).get(msg);
    this.ctx.get(QuestionService).addAnswer(answer.question, answer);

    const contract = this.ctx.config.contracts.find((c) =>
      Hash.equals(c.hash, answer.question.contractAnswerHash)
    );
    if (contract) {
      callWithSyncRequestHandler(
        this.ctx,
        (handler) =>
          contract.func(
            answer.question.params,
            answer.data,
            handler,
          ),
        (isCorrect) => {
          // TODO: Publish collateral here

          console.log(
            `Received publication is ${isCorrect ? 'CORRECT' : 'INCORRECT'}`,
          );
        },
      );
    }

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
