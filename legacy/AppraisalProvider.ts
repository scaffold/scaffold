import { Answer } from './AnswerRegistry.ts';
import { Question } from './QuestionRegistry.ts';
import { Connection } from './ConnectionService.ts';
import { Node } from './NodeService.ts';
import Peer from './Peer.ts';

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

export type PrepareComputeAction = {
  type: 'prepare_compute';
  generator: Answer;
  worker: {};
};

export type DoComputeAction = {
  type: 'compute';
  question: Question;
  generator: Answer;
};

export type ConnectAction = {
  type: 'connect';
  node: Node;
};

// If an action B depends on A, B must not appraise, but must max-update (increase) A's descendant appraisal.
// A descendant appraisal is initiated to zero.

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

export type Action =
  | PublishAction
  | VerifyAction
  | ComputeAction
  | ConnectAction;

export interface Appraisal {
  // This is the expected "profit" of executing this action.
  // For example, if the execution will cost $5, and there's a 10% chance of a $200 return, the expected profit is $200 * 0.1 - $5 = $15.
  value: number;

  computeSeconds: number;
  memoryBytes: number;
  lockedCoins: bigint;
  lockedWorkers: number;
}

// Each "script" can be loaded in zero, one, or more workers.
// Each worker has its own scheduler?
// + Easier to better schedule scripts to where they're easiest to run

export default interface AppraisalProvider {
  // Equivalent actions are guaranteed to be object-equal (===).
  create(onAppraise: (action: Action, prediction: Appraisal) => void): {
    requestAppraisal(action: Action): void;
    onExecute(action: Action): void;
    feedback(action: Action, actual: Appraisal): void;
  };
}
