// Protocol spec: docs/protocol/computation.md (env.put / env.record)
//
// The standard JavaScript compiler contract. "Compiling" JS is really just
// packaging: it loads the author's source, assembles the CONTRACT_CONTRACT
// records (modules stacking the well-known wasi-shim + QuickJS blobs, the
// wasi_setup that boots the `scaffold` global + author source, and the output
// namespaces), `put`s that contract block, and returns its hash.
//
// Not a built-in: this file is excluded from the npm bundle (see
// scripts/build_npm.ts). The library ships no compiler -- a host that wants
// one registers it explicitly and injects the well-known blob hashes:
//
//   scaffold.registerContract(JS_COMPILER_CONTRACT, makeJsCompilerContract(deps))
//
// where `deps` resolves the wasi-shim / QuickJS / json-wb blob hashes (from
// disk under Deno, or as committed constants in the browser; see the dev
// demo's compilerHashes.ts).
//
// Usage (local): invoke it like any contract --
// `put({ contract: JS_COMPILER_CONTRACT, params: { files }, records: {} })` --
// and read the RECORD/'default' result (the new contract block's hash). The
// compiler references the well-known blob blocks by hash, so it does not
// re-publish them.
//
// Source loading: source files come from the compiler's params first (the
// `{ files }` map), then fall back to `env.request` -- a CLI can answer those
// requests from the real filesystem (see Scaffold.registerOutputHandler).

import type { Contract } from './Contract.ts';
import { Hash } from '../util/Hash.ts';
import { CONTRACT_CONTRACT, RECORD_CONTRACT } from '../core/Block.ts';
import { DEFAULT_KEY } from './HashContract.ts';
import { buildJsContractRecordsFromHashes } from './js-runtime/setup.ts';
import { bin2str, str2bin } from '../util/buffer.ts';

/** Well-known hash identifying the standard JS compiler contract. */
export const JS_COMPILER_CONTRACT = Hash.digest('js-compiler-contract');

/** The verifier params a JS-compile invocation carries (JSON-encoded). */
export interface JsCompileInput {
  /** Map of path -> source. The entry file is `/main.js` (or the sole file). */
  files: Record<string, string>;
  /** Reserved for compiler options; unused today. */
  options?: unknown;
}

/** Dependencies the compiler resolves the well-known blob hashes through. */
export interface JsCompilerDeps {
  shimBlobHash(): Hash;
  quickjsBlobHash(): Hash;
  jsonWbBlobHash(): Hash;
}

/**
 * Build the JS compiler contract. `run` packages the author's source into a
 * CONTRACT_CONTRACT block via `env.put`, then records the new block's hash as
 * the RECORD/'default' result. `deps` supplies the well-known blob hashes the
 * compiled contract stacks; the caller chooses how to resolve them (disk under
 * Deno, committed constants in the browser).
 */
export function makeJsCompilerContract(deps: JsCompilerDeps): Contract {
  return {
    // The compiler emits its result as a RECORD/'default' output.
    outputNamespaces: [RECORD_CONTRACT],
    async run(env) {
      const input = parseInput(env.params());
      const source = selectEntrySource(input.files);

      const records = buildJsContractRecordsFromHashes({
        shimHash: deps.shimBlobHash(),
        quickjsHash: deps.quickjsBlobHash(),
        jsonWbHash: deps.jsonWbBlobHash(),
        source,
      });

      // Normalise to bytes: `modules` is a JS object (JSON on the wire); the
      // other records are already Uint8Array.
      const contractRecords: Record<string, Uint8Array> = {};
      for (const [key, value] of Object.entries(records)) {
        contractRecords[key] = value instanceof Uint8Array ? value : str2bin(JSON.stringify(value));
      }

      const contractHash = await env.put(
        { contract: CONTRACT_CONTRACT, params: new Uint8Array(0) },
        contractRecords,
      );

      // env.setResult(contractHash.toBytes());

      // Phase 1: stays on the deprecated record surface (the compiled-contract
      // hash as RECORD/'default'). Migrates to setResult in phase 2 with the
      // contract-registration/WASM work. See docs/protocol/results.md.
      env.record(str2bin(DEFAULT_KEY), contractHash.toBytes());
    },
  };
}

function parseInput(paramsBytes: Uint8Array): JsCompileInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bin2str(paramsBytes));
  } catch (err) {
    throw new Error(
      `js-compiler: params must be JSON {files} (${err instanceof Error ? err.message : err})`,
    );
  }
  const files = (parsed as JsCompileInput)?.files;
  if (!files || typeof files !== 'object') {
    throw new Error('js-compiler: params must include a `files` map');
  }
  return parsed as JsCompileInput;
}

/**
 * Pick the entry source from the files map. Prefers `/main.js`; if there is a
 * single file, uses it. Multi-file projects without `/main.js` are not yet
 * supported (see TODO.md -- needs an `/in/src` VFS mount).
 */
function selectEntrySource(files: Record<string, string>): string {
  if (typeof files['/main.js'] === 'string') return files['/main.js'];
  const keys = Object.keys(files);
  if (keys.length === 1) return files[keys[0]];
  throw new Error(
    `js-compiler: expected an entry file '/main.js' (got ${keys.length} files: ${keys.join(', ')})`,
  );
}
