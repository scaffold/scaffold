import Context from './Context.ts';
import Hash from './util/Hash.ts';
import FulfillmentService from './FulfillmentService.ts';
import { arrConcat, fromNumber } from './util/buffer.ts';
import { bin2hex } from './util/hex.ts';
import { Node } from './NodeService.ts';
import * as hashes from './hashes.ts';
import Logger from './Logger.ts';
import Peer from './Peer.ts';
import { getOrCreate } from './util/map.ts';
import QuestionService from './QuestionService.ts';
import Question from './Question.ts';
import Answer from './Answer.ts';

/*
export interface Answer {
  question: Question;
  data: Uint8Array;
  // fromPeer: Peer;
  fromNode?: Node;
  isCorrect?: boolean;
  timestamp?: BigInt;
}
*/

export default class AnswerService {
  private registry: Map<string, Answer> = new Map();

  constructor(private ctx: Context) {}

  public computeAnswerHash(
    questionHash: Hash,
    answer: Uint8Array,
    nonce?: number,
  ) {
    return Hash.digest(
      arrConcat(
        questionHash.toBytes(),
        answer,
        nonce !== undefined ? fromNumber(nonce, 8) : new Uint8Array([]),
      ),
    );
  }

  public getAnswer(answerHash: Hash) {
    // TODO: Make non-dummy getter
    return new Answer(
      new Question(this.ctx, Hash.digest(''), new Uint8Array([])),
    );
  }

  // public set(
  //   questionHash: Hash,
  //   answerData: Uint8Array,
  // ) {
  //   this.ctx.get(Logger).log('AnswerService', 'set', {
  //     questionHash,
  //     answerData,
  //   });

  //   if (answer.timestamp) {
  //     // this.set(
  //     //   hashes.timeHash,
  //     //   Hash.digest(arrConcat(contractHash.toBytes(), params)).toBytes(),
  //     //   fromNumber(Number(answer.timestamp), 8),
  //     //   {},
  //     // );
  //   }

  //   const hash = this.computeAnswerHash(questionHash, answer.data);
  //   const answer = getOrCreate(this.registry, hash.toHex(), () => {
  //     this.ctx.get(QuestionService).addAnswer(questionHash, answer);
  //     return answer;
  //   });
  //   // answer.callbacks.
  //   const entry = this.registry.get(hash.toHex());
  //   if (entry) {
  //     entry.answer = answer;
  //     entry.callbacks.forEach((cb) => cb(answer));
  //   } else {
  //     this.registry.set(hash.toHex(), { callbacks: [], answer });
  //   }
  // }

  // public get(
  //   questionHash: Hash,
  //   callback: (answer: Answer) => void,
  // ): { release: () => void } {
  //   this.ctx.get(Logger).log('AnswerService', 'get', {
  //     questionHash,
  //   });

  //   const hash = this.computeAnswerHash(questionHash);
  //   let entry = this.registry.get(hash.toHex());
  //   if (entry) {
  //     if (entry.answer) {
  //       callback(entry.answer, entry.meta);
  //     }
  //     entry.callbacks.push(callback);
  //   } else {
  //     entry = { callbacks: [callback], answer: undefined, meta: {} };
  //     this.registry.set(hash.toHex(), entry);

  //     this.ctx.get(FulfillmentService).fulfill(contractHash, params);
  //   }

  //   // TODO
  //   // Send SUB to DHT
  //   // Send SUB to peers

  //   // this.ctx.get(MetadataService).patchMetadata({});

  //   // for (const [peerId, answer] of this.ctx
  //   //   .get(Db)
  //   //   .query(
  //   //     'SELECT peer_id, answer FROM publications WHERE contract_name=? AND contract_params=? ORDER BY id ASC LIMIT 1',
  //   //     [contractName, JSON.stringify(params)]
  //   //   )) {
  //   //   callback(JSON.parse(answer as string));
  //   //   return;
  //   // }

  //   // this.ctx.get(SubscriptionManager).add(contractName, params);

  //   // this.ctx
  //   //   .get(PeerManager)
  //   //   .broadcast({ sub: { contractName, params, bid: 10 } });
  //   // // TODO: Ask or calculate

  //   return {
  //     release: async () => {
  //       let entry;
  //       while (true) {
  //         entry = this.registry.get(hash.toHex());
  //         if (entry) {
  //           break;
  //         }
  //         await new Promise((resolve) => setTimeout(resolve, 0));
  //       }
  //       const idx = entry.callbacks.indexOf(callback);
  //       if (idx === -1) {
  //         throw new Error(
  //           `Callback not found in AnswerService.get().release(); did you call it twice?`,
  //         );
  //       }
  //       entry.callbacks.splice(idx, 1);
  //     },
  //   };
  // }
}
