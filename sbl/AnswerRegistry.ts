import { Connection, SELF_CONNECTION } from './ConnectionService.ts';
import Context from './Context.ts';
import ForwardingService from './ForwardingService.ts';
import { PublishMessage } from './messages.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import QuestionService from './QuestionService.ts';
import { assert } from './util/functional.ts';
import Hash from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';

export interface AnswerComputation {
  difficultyEstimate?: bigint;
  generatorInputs: Hash[];
  isCorrect: boolean;
}

export interface AnswerVerification {
  isCorrect: boolean;
}

export interface Answer {
  //   // fromPeer: Peer;

  //   // This gets (1) set when the answer is received, and (2) reduced to the min if we see another answer including this answer's hash in its inputs.
  //   private latestTimestamp: number = Date.now();

  //   private collateral: Map<
  //     string,
  //     { peer: Peer; amount: number; support: boolean; signedMsg: Uint8Array }
  //   > = new Map();
  //   private sumSupport = 0;

  //   public fromNode?: Node;
  //   public isCorrect?: boolean;
  //   // public timestamp: bigint;

  //   public licensedFor?: Question[];

  //   public isAddedToQuestion = false;

  //   public creationTime: number;

  //   public packets: { fromConn: Connection; packetData: Uint8Array }[] = [];

  //   constructor(
  //     public hash: Hash,
  //     public question: Question,
  //     public publication: PublishMessage,
  //   ) {
  //     this.creationTime = Date.now();

  //   }

  question: Question;

  data: Uint8Array;

  firstReceivedFrom: Connection | SELF_CONNECTION;
  signedMsg: Uint8Array;

  computation?: AnswerComputation;
  verification?: AnswerVerification; // Array?

  creationTime: number;
}

export default class AnswerRegistry {
  private registry: Map<string, Answer> = new Map();

  // private static computeHash(questionHash: Hash, answer: Uint8Array) {
  //   const nonce = 0;

  //   // TODO: Should more stuff be in here?
  //   // Gotta make sure here that modifying answer data can't create collisions
  //   return Hash.digest(
  //     arrConcat(questionHash.toBytes(), fromNumber(nonce, 8), answer),
  //   );
  // }

  constructor(private ctx: Context) {}

  public peek(hash: Hash) {
    return this.registry.get(hash.toHex());
  }

  public getOrCreate(
    msgCtx: { conn: Connection | SELF_CONNECTION; packetData: Uint8Array },
    publication: PublishMessage,
    computation?: AnswerComputation,
  ) {
    assert((msgCtx.conn === SELF_CONNECTION) === !!computation);

    const question = this.ctx
      .get(QuestionRegistry)
      .getOrCreate(publication.question);
    const hash = Hash.digest(msgCtx.packetData); // This is the hash of the entire packet (including the signature), not just the message.
    return getOrCreate(this.registry, hash.toHex(), () => {
      const answer: Answer = {
        question,
        data: publication.answer,
        firstReceivedFrom: msgCtx.conn,
        signedMsg: msgCtx.packetData,
        computation,
        verification: undefined,
        creationTime: Date.now(),
      };
      this.ctx.get(QuestionService).addAnswerToQuestion(answer);
      this.ctx
        .get(ForwardingService)
        .forwardPublication(publication, msgCtx.conn);
      return answer;
    });
  }
}
