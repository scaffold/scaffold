/**
 * Block filter query parser.
 *
 * Grammar:
 *   query       = term ("," term)*
 *   term        = predicate+
 *   predicate   = "-" predicate | boolean | comparison | func_call | hash_prefix
 *   boolean     = bare_word                        (canonical, head, genesis, leaf)
 *   comparison  = key ":" comp_op? atom
 *   func_call   = key "(" args ")"
 *   hash_prefix = [0-9a-f]{4,64}
 *   comp_op     = ">" | ">=" | "<" | "<="
 *   atom        = number duration_suffix? | bare_word
 */

// -- AST types --------------------------------------------------------------

export type Query = Term[];

export type Term = Predicate[];

export type Predicate =
  | BooleanPredicate
  | ComparisonPredicate
  | FunctionPredicate
  | HashPredicate;

export interface BooleanPredicate {
  type: "boolean";
  name: string;
  negated: boolean;
}

export interface ComparisonPredicate {
  type: "comparison";
  key: string;
  op: ComparisonOp;
  value: number;
  negated: boolean;
}

export interface FunctionPredicate {
  type: "function";
  name: string;
  args: string[];
  negated: boolean;
}

export interface HashPredicate {
  type: "hash";
  prefix: string;
  negated: boolean;
}

export type ComparisonOp = ">" | ">=" | "<" | "<=" | "=";

/** Known boolean predicate names. */
export const BOOLEAN_PREDICATES = new Set([
  "canonical",
  "head",
  "genesis",
  "leaf",
]);

/** Known comparison keys. */
export const COMPARISON_KEYS = new Set(["weight", "throughput", "age"]);

/** Known function names. */
export const FUNCTION_NAMES = new Set(["outputs"]);

// -- Duration parsing -------------------------------------------------------

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a duration string like "5m", "30s", "1h" into milliseconds.
 * Returns null if the string is not a valid duration.
 */
export function parseDuration(s: string): number | null {
  const match = s.match(/^(\d+(?:\.\d+)?)(s|m|h)$/);
  if (!match) return null;
  return parseFloat(match[1]) * DURATION_MULTIPLIERS[match[2]];
}

// -- Parser -----------------------------------------------------------------

/**
 * Parse a query string into an AST.
 * Returns an array of Terms (OR-separated). Each Term is an array of
 * Predicates (AND-separated).
 *
 * Throws on syntax errors with a human-readable message.
 */
export function parseQuery(input: string): Query {
  const trimmed = input.trim();
  if (trimmed === "") return [];

  const terms = trimmed.split(",");
  const query: Query = [];

  for (const termStr of terms) {
    const tokens = termStr.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;

    const term: Term = [];
    for (const token of tokens) {
      term.push(parseToken(token));
    }
    query.push(term);
  }

  return query;
}

function parseToken(token: string): Predicate {
  let negated = false;
  let rest = token;

  if (rest.startsWith("-")) {
    negated = true;
    rest = rest.slice(1);
  }

  // Function call: name(args)
  const funcMatch = rest.match(/^([a-zA-Z_]\w*)\((.+)\)$/);
  if (funcMatch) {
    const name = funcMatch[1];
    const args = funcMatch[2].split(",").map((a) => a.trim());
    return { type: "function", name, args, negated };
  }

  // Comparison: key:value
  const colonIdx = rest.indexOf(":");
  if (colonIdx !== -1) {
    const key = rest.slice(0, colonIdx);
    if (COMPARISON_KEYS.has(key)) {
      let valueStr = rest.slice(colonIdx + 1);
      let op: ComparisonOp = "=";

      if (valueStr.startsWith(">=")) {
        op = ">=";
        valueStr = valueStr.slice(2);
      } else if (valueStr.startsWith(">")) {
        op = ">";
        valueStr = valueStr.slice(1);
      } else if (valueStr.startsWith("<=")) {
        op = "<=";
        valueStr = valueStr.slice(2);
      } else if (valueStr.startsWith("<")) {
        op = "<";
        valueStr = valueStr.slice(1);
      }

      let value: number;
      if (key === "age") {
        const dur = parseDuration(valueStr);
        if (dur === null) throw new Error(`Invalid duration: ${valueStr}`);
        value = dur;
      } else {
        value = parseFloat(valueStr);
        if (isNaN(value)) throw new Error(`Invalid number: ${valueStr}`);
      }

      return { type: "comparison", key, op, value, negated };
    }
  }

  // Boolean predicate
  if (BOOLEAN_PREDICATES.has(rest)) {
    return { type: "boolean", name: rest, negated };
  }

  // Hash prefix: 4+ lowercase hex chars
  if (/^[0-9a-f]{4,64}$/.test(rest)) {
    return { type: "hash", prefix: rest, negated };
  }

  throw new Error(`Unknown predicate: ${rest}`);
}
