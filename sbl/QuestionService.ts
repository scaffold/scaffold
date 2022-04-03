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
import { HashExpr } from './messages.ts';
import WorkQueue from './WorkQueue.ts';
import Question from './Question.ts';
import Answer from './Answer.ts';
import NodeService from './NodeService.ts';
import PublicationService from './PublicationService.ts';
import { assert } from './util/functional.ts';

export default class QuestionService {
  private registry: Map<string, Question> = new Map();

  constructor(private ctx: Context) {}

  public computeQuestionHash(
    contractHash: Hash,
    params: Uint8Array,
    // nonce?: number,
  ) {
    const nonce = undefined;
    return Hash.digest(
      arrConcat(
        contractHash.toBytes(),
        params,
        nonce !== undefined ? fromNumber(nonce, 8) : new Uint8Array([]),
      ),
    );
  }

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

  public getQuestion(questionHash: Hash) {
    return getOrCreate(
      this.registry,
      questionHash.toHex(),
      () => new Question(questionHash),
    );
  }

  public addAnswer(question: Question, answer: Answer) {
    question.answers.push(answer);

    question.subscriptions.forEach((node) =>
      this.ctx.get(PublicationService).publish(node, answer)
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
    contractHash: Hash,
    params: Uint8Array,
    callback: (answer: Answer) => void,
  ): { release: () => void } {
    this.ctx.get(Logger).log('QuestionService', 'getCanonical', {
      contractHash,
      params,
    });

    const hash = this.computeQuestionHash(contractHash, params);
    const entry = getOrCreate(
      this.registry,
      hash.toHex(),
      () => new Question(hash, contractHash, params),
      (q) => {
        if (q.contractHash && !Hash.equals(contractHash, q.contractHash)) {
          throw new Error(`Mismatching contract hash`);
        }
        if (q.params && !arrEquals(params, q.params)) {
          throw new Error(`Mismatching params`);
        }
        q.contractHash = contractHash;
        q.params = params;
        return q;
      },
    );

    entry.canonicalCallbacks.push(callback);
    if (entry.canonicalAnswer) {
      callback(entry.canonicalAnswer);
    }

    if (!entry.isFulfilling) {
      this.ctx.get(FulfillmentService).fulfill(entry);
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
