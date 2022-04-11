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

    answer.licenses.forEach(({ question_hash, incentive }) =>
      this.ctx.get(QuestionRegistry).getByHash(question_hash).addIncentive(
        question.hash,
        answer.hash,
        incentive,
      )
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

  public getCanonical(
    // contract:Answer,
    // params: Uint8Array,

    spec: QuestionSpec,
    callback: (answer: Answer) => void,
  ): { release: () => void } {
    this.ctx.get(Logger).log('QuestionService', 'getCanonical', { spec });

    const entry = this.ctx.get(QuestionRegistry).getBySpec(spec);

    entry.canonicalCallbacks.push(callback);
    if (entry.canonicalAnswer) {
      callback(entry.canonicalAnswer);
    }

    if (!entry.isFulfilling) {
      this.ctx.get(FulfillmentService).fulfill(entry, 1000000n);
      assert(entry.isFulfilling);
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
      release: () => {
        const idx = entry.canonicalCallbacks.indexOf(callback);
        if (idx === -1) {
          throw new Error(
            `Callback not found in AnswerService.getCanonical().release(); did you call it twice?`,
          );
        }
        entry.canonicalCallbacks.splice(idx, 1);
      },
    };
  }
}
