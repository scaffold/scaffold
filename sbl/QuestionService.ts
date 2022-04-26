import Context from './Context.ts';
import Hash from './util/Hash.ts';
import FulfillmentService from './FulfillmentService.ts';
import { arrConcat, arrEquals, fromNumber } from './util/buffer.ts';
import { bin2hex } from './util/hex.ts';
import { Node } from './NodeService.ts';
import * as constants from './constants.ts';
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
import EnvoyContract from '~/graph/EnvoyContract.ts';
import * as envoyMessages from '~/graph/envoyMessages.ts';

const envoyIncentive = 10n;

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

  private updateIncentives(question: Question, stack: string[]) {
    const totalIncentive = question.getTotalIncentive();
    if (totalIncentive > 10n) {
      this.ctx.get(WorkQueue).set(
        question.hash,
        Number(totalIncentive),
        () => {
          if (!question.isFulfilling) {
            this.ctx.get(FulfillmentService).fulfill(question, stack);
          }
          return Promise.resolve();
        },
      );
    } else {
      this.ctx.get(WorkQueue).remove(question.hash);
    }
  }

  public addAnswerToQuestion(answer: Answer) {
    if (answer.isAddedToQuestion) {
      return;
    }
    answer.isAddedToQuestion = true;

    const question = answer.question;

    // this.ctx.get(Logger).log('QuestionService', 'addAnswer', {
    //   cah: question.contractAnswerHash,
    //   params: question.params,
    //   answer: answer.data,
    // });

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
      this.updateIncentives(childQuestion, ['addAnswerToQuestion']);
    });

    // if (answer.timestamp) {
    //   this.set(
    //     constants.timeHash,
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
    stack: string[] = [],
  ) {
    stack = [...stack, this.ctx.get(QaDebugger).debugQuestion(spec)];
    // console.log('QuestionService.getCanonical', stack.join(' -> '));

    const question = this.ctx.get(QuestionRegistry).getBySpec(spec);
    const envoy = this.ctx.get(QuestionRegistry).getBySpec({
      contract_answer_hash: this.ctx.get(EnvoyContract).get().hash,
      params: envoyMessages.Params.encode({
        question: spec,
        nonce: Hash.random(),
      }),
    });

    const incentivize = (newAmount: bigint) => {
      console.log(
        'QuestionService.getCanonical.incentivize',
        newAmount,
        stack.join(' -> '),
      );

      if (question.canonicalAnswer) {
        return;
      }

      // This incentivizes the computation of an answer to this question.
      // To be claimed it must be included in the answer's inputs, so if the answer is already computed, it won't have any effect.
      // If the answer is already computed, the incentive won't be consumed and can be reclaimed, however it's likely no answer will be returned.

      // This incentivizes the fetching of an answer to this question.
      // It incentivizes a special envoy message, which wraps the original answer.
      // The envoy message can be created long after the answer is computed, so will be effective at any time.
      // If the answer is not yet computed, some of the incentive will likely be paid towards computation.

      const envoyAmount = newAmount < envoyIncentive
        ? newAmount
        : envoyIncentive;
      this.ctx.get(IncentiveService).incentivize(envoy, envoyAmount);
      this.ctx.get(IncentiveService).incentivize(
        question,
        newAmount - envoyAmount,
      );
      this.updateIncentives(question, stack);
    };
    incentivize(0n);

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
      question,
      incentivize,
      onAnswer: (callback: (answer: Answer) => void) => {
        question.canonicalCallbacks.push(callback);
        if (question.canonicalAnswer) {
          callback(question.canonicalAnswer);
        }

        return {
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
      },
    };
  }
}
