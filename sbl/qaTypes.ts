import Hash from './util/Hash.ts';

export interface Contract {
  source: Question;
}

export interface Question {
  contract: Contract;
  params: Uint8Array;
  answers: Answer[];
}

export interface Answer {
  isCorrect?: boolean;
  fromNode?: Node;
  timestamp?: BigInt;
  postings: Map<string, Collateral>;
}

export interface Collateral {
  value: number;
}
