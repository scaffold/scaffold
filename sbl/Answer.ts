import Peer from './Peer.ts';
import Question from './Question.ts';
import { Node } from './NodeService.ts';
import { PublishMessage } from './messages.ts';
import Hash from './util/Hash.ts';
import { arrConcat } from './util/buffer.ts';

export default class Answer {
  public hash: Hash;
  // fromPeer: Peer;

  public publication: PublishMessage; // ???

  // This gets (1) set when the answer is received, and (2) reduced to the min if we see another answer including this answer's hash in its inputs.
  private latestTimestamp: number = Date.now();

  private collateral: Map<
    string,
    { peer: Peer; amount: number; support: boolean; signedMsg: Uint8Array }
  > = new Map();
  private sumSupport = 0;

  public fromNode?: Node;
  public isCorrect?: boolean;
  public timestamp?: BigInt;

  public licensedFor?: Question[];

  constructor(public question: Question, public data: Uint8Array) {
    this.hash = Hash.digest(data);
  }

  // public addCollateral(
  //   question: Question,
  //   answer: Answer,
  //   msgCtx: MessageCtx,
  //   peer: Peer,
  //   amount: number,
  //   support: boolean,
  // ) {
  //   // TODO: Index by signature
  //   // answer.collateral
  //   this.collateral.set(msgCtx.msgHash.toHex(), {});
  // }
}
