/**
 * Block filter module -- re-exports parser, evaluator, and ghost computation.
 */
export { parseDuration, parseQuery } from './parse.ts';
export type {
  BooleanPredicate,
  ComparisonOp,
  ComparisonPredicate,
  FunctionPredicate,
  HashPredicate,
  Predicate,
  Query,
  Term,
} from './parse.ts';

export { compareValues, evaluatePredicate, evaluateQuery, evaluateTerm } from './evaluate.ts';
export type { BlockInfo } from './evaluate.ts';

export { computeGhostHashes } from './ghost.ts';
export type { BlockEdges } from './ghost.ts';
