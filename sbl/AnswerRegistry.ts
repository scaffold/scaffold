import Context from './Context.ts';
import HashMap from './util/HashMap.ts';
import { HashExpr, License, PublishMessage, QuestionSpec } from './messages.ts';
import { assert, error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import { arrConcat, arrEquals, fromNumber } from './util/buffer.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import PublicationService from './PublicationService.ts';
import NodeService from './NodeService.ts';
import { getOrCreate } from './util/map.ts';
import { Node } from './NodeService.ts';
import Peer from './Peer.ts';
import QuestionService from './QuestionService.ts';
import { Connection, SELF_CONNECTION } from './ConnectionService.ts';
import ForwardingService from './ForwardingService.ts';

export class Answer {
  // fromPeer: Peer;

  public inputs: Hash[];

  public data: Uint8Array;

  public licenses: License[];

  // This gets (1) set when the answer is received, and (2) reduced to the min if we see another answer including this answer's hash in its inputs.
  private latestTimestamp: number = Date.now();

  private collateral: Map<
    string,
    { peer: Peer; amount: number; support: boolean; signedMsg: Uint8Array }
  > = new Map();
  private sumSupport = 0;

  public fromNode?: Node;
  public isCorrect?: boolean;
  public timestamp: bigint;

  public difficultyEstimate?: bigint;

  public licensedFor?: Question[];

  public isAddedToQuestion = false;

  public receptionTime: number;

  constructor(
    public hash: Hash,
    public question: Question,
    { inputs, answer, licenses, timestamp }: PublishMessage,
    public receivedFrom: Connection | SELF_CONNECTION,
  ) {
    this.inputs = inputs;
    this.data = answer;
    this.licenses = licenses;
    this.timestamp = timestamp;
    this.receptionTime = Date.now();
  }
}

export default class AnswerRegistry {
  private registry: Map<string, Answer> = new Map();

  private static computeHash(questionHash: Hash, answer: Uint8Array) {
    const nonce = 0;

    // TODO: Should more stuff be in here?
    // Gotta make sure here that modifying answer data can't create collisions
    return Hash.digest(
      arrConcat(questionHash.toBytes(), fromNumber(nonce, 8), answer),
    );
  }

  constructor(private ctx: Context) {}

  public peek(hash: Hash) {
    return this.registry.get(hash.toHex());
  }

  public getOrCreate(
    publication: PublishMessage,
    conn: Connection | SELF_CONNECTION,
  ) {
    const question = this.ctx.get(QuestionRegistry).getOrCreate(
      publication.question,
    );
    const hash = AnswerRegistry.computeHash(question.hash, publication.answer);
    return getOrCreate(this.registry, hash.toHex(), () => {
      const answer = new Answer(hash, question, publication, conn);
      this.ctx.get(QuestionService).addAnswerToQuestion(answer);
      this.ctx.get(ForwardingService).forwardPublication(publication, conn);
      return answer;
    });
  }
}
