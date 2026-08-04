// Protocol spec: docs/design/wasi-shim.md (virtual filesystem)
//
// The JS-runtime bootstrap prelude. This is prepended to a contract author's
// JavaScript source before it is evaluated by QuickJS (run via the wasi-shim).
// It defines the `scaffold` global the author writes against, then dispatches
// to the author's `run()`.
//
// QuickJS is an *unmodified* WASI binary, so its only channel to the host is
// the wasi-shim virtual filesystem. The `scaffold` global hides that behind
// clean methods:
//   - `scaffold.params()`  reads `/in/params`        (the verifier params bytes)
//   - `scaffold.result(s)` writes `/out/record/default` (the contract's result)
//
// `std` (QuickJS's file API) is only available when the program is run with the
// `--std` flag -- `buildJsContractRecords` sets `argv = ['qjs', '--std', '-e', ...]`.
//
// Serialization note: this runtime is string/UTF-8 oriented. `params()` returns
// the params bytes decoded as a string (the generic JSON walker/builder produces
// JSON, so contracts `JSON.parse(scaffold.params())`), and `result()` writes a
// string. Binary-oriented contracts use a different runtime.

/**
 * The `scaffold` global, as JavaScript source. Prepended to author source by
 * `wrapJsProgram`. Kept as a string (not a real module) because it is embedded
 * into the contract block and evaluated inside QuickJS, not in this process.
 */
export const SCAFFOLD_PRELUDE = `
globalThis.scaffold = {
  /** The verifier params for this invocation, as a UTF-8 string (often JSON). */
  params() {
    return std.loadFile('/in/params') || '';
  },
  /** Publish the contract's result. Lands as a RECORD/'default' output. */
  result(body) {
    const f = std.open('/out/record/default', 'w');
    f.puts(body);
    f.close();
  },
};
`;

/**
 * Dispatch appended after author source: invoke the author's \`run()\`.
 * (Build/walk modes are handled by a separate generic JSON walker/builder
 * layer, not by QuickJS, so this runtime only dispatches \`run\`.)
 */
export const SCAFFOLD_DISPATCH = `
if (typeof run === 'function') {
  run();
} else {
  throw new Error('scaffold js-runtime: contract source must define a run() function');
}
`;

/**
 * Wrap a contract author's JavaScript source into the full program string the
 * QuickJS contract evaluates: the `scaffold` global, then the author's source,
 * then the dispatch to `run()`.
 */
export function wrapJsProgram(userSource: string): string {
  return `${SCAFFOLD_PRELUDE}\n${userSource}\n${SCAFFOLD_DISPATCH}`;
}
