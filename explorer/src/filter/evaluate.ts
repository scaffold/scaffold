/**
 * Block filter query evaluator.
 *
 * Takes a parsed query AST and a BlockInfo snapshot, returns whether the
 * block matches. Pure function -- no side effects, no scaffold.io dependency.
 */

import type { ComparisonOp, Predicate, Query, Term } from "./parse.ts";

// -- BlockInfo --------------------------------------------------------------

/**
 * A snapshot of block properties needed for filter evaluation.
 * Computed once per block per filter cycle -- kept flat and simple so it
 * does not depend on scaffold.io types.
 */
export interface BlockInfo {
  /** Block hash as lowercase hex string. */
  hash: string;
  /** Whether consensus considers this block canonical. */
  isCanonical: boolean;
  /** Whether no other block aggregates this block. */
  isHead: boolean;
  /** Whether the block's anchor is the zero hash (genesis). */
  isGenesis: boolean;
  /** Whether the block's aggregates array is empty. */
  isLeaf: boolean;
  /** Block's declared weight. */
  declaredWeight: number;
  /** Sum of output values (== sum of input values by throughput balancing). */
  throughput: number;
  /** When this node received the block (Date.now() at reception). */
  receivedAt: number;
  /** Hex strings of verifier.contract for each output. */
  outputContracts: string[];
}

// -- Evaluator --------------------------------------------------------------

/**
 * Evaluate a parsed query against a single block.
 *
 * Query is OR of Terms; each Term is AND of Predicates.
 * An empty query (no terms) matches nothing.
 */
export function evaluateQuery(
  query: Query,
  block: BlockInfo,
  now?: number,
): boolean {
  if (query.length === 0) return false;
  const t = now ?? Date.now();
  return query.some((term) => evaluateTerm(term, block, t));
}

/**
 * Evaluate a single Term (AND of predicates) against a block.
 */
export function evaluateTerm(
  term: Term,
  block: BlockInfo,
  now: number,
): boolean {
  return term.every((pred) => evaluatePredicate(pred, block, now));
}

/**
 * Evaluate a single Predicate against a block.
 */
export function evaluatePredicate(
  pred: Predicate,
  block: BlockInfo,
  now: number,
): boolean {
  let result: boolean;

  switch (pred.type) {
    case "boolean": {
      const map: Record<string, keyof BlockInfo> = {
        canonical: "isCanonical",
        head: "isHead",
        genesis: "isGenesis",
        leaf: "isLeaf",
      };
      result = block[map[pred.name]] as boolean;
      break;
    }
    case "comparison": {
      let actual: number;
      switch (pred.key) {
        case "weight":
          actual = block.declaredWeight;
          break;
        case "throughput":
          actual = block.throughput;
          break;
        case "age":
          actual = now - block.receivedAt;
          break;
        default:
          result = false;
          return pred.negated ? !result : result;
      }
      result = compareValues(actual, pred.op, pred.value);
      break;
    }
    case "function": {
      if (pred.name === "outputs") {
        const prefix = pred.args[0];
        result = block.outputContracts.some((c) => c.startsWith(prefix));
      } else {
        result = false;
      }
      break;
    }
    case "hash": {
      result = block.hash.startsWith(pred.prefix);
      break;
    }
    default:
      result = false;
  }

  return pred.negated ? !result : result;
}

/**
 * Apply a comparison operator.
 */
export function compareValues(
  actual: number,
  op: ComparisonOp,
  expected: number,
): boolean {
  switch (op) {
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
    case "=":
      return actual === expected;
  }
}
