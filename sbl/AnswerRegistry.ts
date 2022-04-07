import Context from './Context.ts';
import HashMap, { HashMapEntry } from './util/HashMap.ts';
import { HashExpr, License, PublishMessage, QuestionSpec } from './messages.ts';
import { assert, error } from './util/functional.ts';
import Hash from './util/Hash.ts';
import { arrConcat, arrEquals, fromNumber } from './util/buffer.ts';
import QuestionRegistry, {
  Question,
  QuestionEntry,
} from './QuestionRegistry.ts';
import PublicationService from './PublicationService.ts';
import NodeService from './NodeService.ts';
import { getOrCreate } from './util/map.ts';
import { Node } from './NodeService.ts';
import Peer from './Peer.ts';

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

  public licensedFor?: Question[];

  constructor(
    public question: Question,
    { inputs, answer, licenses, timestamp }: PublishMessage,
  ) {
    this.inputs = inputs;
    this.data = answer;
    this.licenses = licenses;
    this.timestamp = timestamp;
  }
}

export default class AnswerRegistry extends HashMap<Answer> {
  private static computeHash(questionHash: Hash, answer: Uint8Array) {
    const nonce = 0;

    // TODO: Should more stuff be in here?
    // Gotta make sure here that modifying answer data can't create collisions
    return Hash.digest(
      arrConcat(questionHash.toBytes(), fromNumber(nonce, 8), answer),
    );
  }

  constructor(private ctx: Context) {
    super();
  }

  // public get(spec: QuestionSpec) {
  //   return this.getOrCreate(spec, () => new Answer());
  // }

  public get(publication: PublishMessage) {
    const { hash: questionHash, val: question } = this.ctx.get(QuestionRegistry)
      .get(publication.question);
    return this.getOrCreate(
      AnswerRegistry.computeHash(questionHash, publication.answer),
      () => new Answer(question, publication),
    );
  }
}

export type AnswerEntry = HashMapEntry<Answer>;
