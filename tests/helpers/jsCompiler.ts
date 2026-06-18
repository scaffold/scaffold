// Test helper: register the JS compiler contract on a Scaffold, resolving the
// well-known blob hashes off disk (Deno). The compiler is no longer a built-in
// (it is excluded from the npm bundle), so hosts -- including tests -- register
// it explicitly. Mirrors what the dev demo does with committed constants.

import type { Scaffold } from '../../src/Scaffold.ts';
import {
  JS_COMPILER_CONTRACT,
  makeJsCompilerContract,
} from '../../src/contracts/JsCompilerContract.ts';
import { getJsonWbBlobHash, getQuickjsBlobHash, getShimBlobHash } from '../../src/wellKnown.ts';

/** Register the JS compiler under its well-known hash, with disk-loaded deps. */
export function registerJsCompiler(scaffold: Scaffold): void {
  scaffold.registerContract(
    JS_COMPILER_CONTRACT,
    makeJsCompilerContract({
      shimBlobHash: getShimBlobHash,
      quickjsBlobHash: getQuickjsBlobHash,
      jsonWbBlobHash: getJsonWbBlobHash,
    }),
  );
}
