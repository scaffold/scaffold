class Hash<T> {}
class Signed<T> {}


interface Proof {
  known
  [side: boolean;
    other_data: Hash<unknown>;]



}

interface Debit {
}

interface Question {
}

interface Answer {
  inputs: Hash<Answer>[];
  data: Uint8Array;
}

interface Subscription {}

interface Publication {
  question: Hash<Question>; // or Question?
  answer: Answer; // or Hash<Answer>?
}

interface Citation {
  payment: Hash<>;
}

interface UnknownHash {
  hash: Hash<unknown>;
}

type SubMsg = Signed<Subscription>;
type PubMsg = Signed<Publication>;
type CiteMsg = Signed<Citation>;

type Packet = PubMsg;

/*
PubMsg
  Hash<Question> question_hash; // or Question?
  Hash<Answer> answer_hash; // or Answer?
  Map<Hash<Question>, BigInt> licenses;
  BigInt first_collateral;
  BigInt valid_collateral;
  Hash<LockId> balance_lock;
SubMsg
  Hash<Question> question_hash; // or Question?
  Hash<Question> child_question_hash; // or Question?
  BigInt bid;
CiteMsg
Question
Answer
  List<Hash<Node>> inputs; // Or map from Hash<Question>?
  Uint8Array data;


Contract
  (Wasm | Human) type;
  Hash<Node> code;
  Uint8Array params;
Node
  List<Hash<Node>> inputs;
  Uint8Array answer;
Commitment (signed)
  Hash<Node> data;
  Contract contract;
  BigInt value;
*/
