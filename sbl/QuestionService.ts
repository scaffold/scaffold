import Context from './Context.ts';
import Hash from './util/Hash.ts';
import FulfillmentService from './FulfillmentService.ts';
import { arrConcat, arrEquals, fromNumber } from './util/buffer.ts';
import { bin2hex } from './util/hex.ts';
import { Node } from './NodeService.ts';
import * as hashes from './hashes.ts';
import Logger from './Logger.ts';
import { getOrCreate } from './util/map.ts';
import Peer from './Peer.ts';
import MessageCtx from './MessageCtx.ts';
import { HashExpr, QuestionSpec } from './messages.ts';
import WorkQueue from './WorkQueue.ts';
import NodeService from './NodeService.ts';
import PublicationService from './PublicationService.ts';
import { assert, error } from './util/functional.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import { Answer } from './AnswerRegistry.ts';
import QaDebugger from './QaDebugger.ts';
import IncentiveService from './IncentiveService.ts';

export default class QuestionService {
  constructor(private ctx: Context) {}

  public computeAnswerHash(
    questionHash: Hash,
    answerData: Uint8Array,
    nonce?: number,
  ) {
    return Hash.digest(
      arrConcat(
        questionHash.toBytes(),
        answerData,
        nonce !== undefined ? fromNumber(nonce, 8) : new Uint8Array([]),
      ),
    );
  }

  // public getQuestion(questionHash: Hash) {
  //   return getOrCreate(
  //     this.registry,
  //     questionHash.toHex(),
  //     () => new Question(questionHash),
  //   );
  // }

  public addAnswerToQuestion(answer: Answer) {
    if (answer.isAddedToQuestion) {
      return;
    }
    answer.isAddedToQuestion = true;

    const question = answer.question;

    this.ctx.get(Logger).log('QuestionService', 'addAnswer', {
      cah: question.contractAnswerHash,
      params: question.params,
      answer: answer.data,
    });

    question.answers.push(answer);
    if (!question.canonicalAnswer) {
      question.canonicalAnswer = answer;
      question.canonicalCallbacks.forEach((cb) => cb(answer));
    }

    // question.subscriptions.forEach((node) =>
    //   this.ctx.get(PublicationService).publish(node, answer)
    // );

    answer.licenses.forEach(({ question_hash, incentive }) => {
      const childQuestion = this.ctx.get(QuestionRegistry).getByHash(
        question_hash,
      );
      childQuestion.addIncentive(question.hash, answer.hash, incentive);
      this.ctx.get(WorkQueue).set(
        childQuestion.hash,
        Number(childQuestion.getTotalIncentive()),
        () => {
          if (!childQuestion.isFulfilling) {
            this.ctx.get(FulfillmentService).fulfill(
              childQuestion,
              1000000n,
              10,
              ['addAnswerToQuestion'],
            );
            assert(childQuestion.isFulfilling);
          }
          return Promise.resolve();
        },
      );
    });

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

  public getCanonical(
    // contract:Answer,
    // params: Uint8Array,

    spec: QuestionSpec,
    callback: (answer: Answer) => void,
    recursionLimit = 10,
    stack: string[] = [],
  ) {
    stack = [
      ...stack,
      this.ctx.get(QaDebugger).debugQuestion(spec) + '/' + recursionLimit,
    ];
    console.log('QuestionService.getCanonical', stack.join(' -> '));

    const question = this.ctx.get(QuestionRegistry).getBySpec(spec);

    question.canonicalCallbacks.push(callback);
    if (question.canonicalAnswer) {
      callback(question.canonicalAnswer);
    }

    if (!question.isFulfilling && recursionLimit > 0) {
      this.ctx.get(FulfillmentService).fulfill(
        question,
        1000000n,
        recursionLimit,
        stack,
      );
      assert(question.isFulfilling);
    }

    // TODO
    // Send SUB to DHT
    // Send SUB to peers

    // this.ctx.get(MetadataService).patchMetadata({});

    // for (const [peerId, answer] of this.ctx
    //   .get(Db)
    //   .query(
    //     'SELECT peer_id, answer FROM publications WHERE contract_name=? AND contract_params=? ORDER BY id ASC LIMIT 1',
    //     [contractName, JSON.stringify(params)]
    //   )) {
    //   callback(JSON.parse(answer as string));
    //   return;
    // }

    // this.ctx.get(SubscriptionManager).add(contractName, params);

    // this.ctx
    //   .get(PeerManager)
    //   .broadcast({ sub: { contractName, params, bid: 10 } });
    // // TODO: Ask or calculate

    return {
      incentivize: (amount: bigint) =>
        this.ctx.get(IncentiveService).incentivize(question, amount),
      release: () => {
        const idx = question.canonicalCallbacks.indexOf(callback);
        if (idx === -1) {
          throw new Error(
            `Callback not found in AnswerService.getCanonical().release(); did you call it twice?`,
          );
        }
        question.canonicalCallbacks.splice(idx, 1);
      },
    };
  }
}
