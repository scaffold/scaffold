import { Answer } from './AnswerRegistry.ts';
import { Question } from './QuestionRegistry.ts';
import { Connection } from './ConnectionService.ts';
import { Node } from './NodeService.ts';

export type PublishAction = {
  type: 'publish';
  answer: Answer;
  node: Node;
};
// For this, the expected return of one send is high, and subsequent sends lower.
// An action's return can be divided by the execution of N other actions.

export type VerifyAction = {
  type: 'verify';
  answer: Answer;
};
export type ComputeAction = {
  type: 'compute';
  generatorAnswer: Answer;
  question: Question;
  params: Uint8Array;
};

// Given a generator that requests N parents, get N weights to distribute the incentive appropriately.
// What's the expected difficulty (price) of an answer to a question Q?
// This will be negative return, but a subsequent publication may be sum positive.
// -- What's the expected probability of an answer A becoming canonical? --
// This will be implicitly included in a lot of other incentives.

// Network acceptance: Probability that the network has accepted some answer as canonical.
// Either is true or is false at time=Infinity, but eventual value is unknown.

// interface State<T> {
//   update(): void;
//   value: T;
//   dependencies: { update(): void }[];
// }

export type Action = PublishAction | VerifyAction | ComputeAction;

export interface Appraisal {
  value: number;
  compute: number;
  memory: number;
  lockedCoins: bigint;
}

export default interface AppraisalProvider {
  // Equivalent actions are guaranteed to be object-equal (===).
  create(onAppraise: (action: Action, prediction: Appraisal) => void): {
    requestAppraisal(action: Action): void;
    onExecute(action: Action): void;
    feedback(action: Action, actual: Appraisal): void;
  };
}
