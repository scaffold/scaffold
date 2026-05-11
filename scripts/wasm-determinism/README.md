# wasm-determinism

Idempotent transformer that rewrites a WASM module so it executes
deterministically across every engine. Two artifacts ship from this
directory:

- **`bin/wasm-determinism.wasm`** -- standalone tool, exports
  `transform(input_len) -> i32`. Bytes in / bytes out, used by
  `tests/WasmDeterminism.test.ts`.
- **`bin/wasm-determinism-contract.wasm`** -- the same transform logic
  wrapped as a Scaffold contract (imports from `scaffold_env.*`, exports
  `alloc` and `run`). One blob, two contract deployments (transform mode
  and verify mode) selected via a record on the introducing block.

## API

Compiled to `wasm32-freestanding`. Imports `env.memory` + `env.log(ptr, len)`.

Exports:

- `input_buffer() -> u32` -- offset where the host writes input bytes
- `output_buffer() -> u32` -- offset where the host reads output bytes
- `input_capacity() -> u32`, `output_capacity() -> u32`
- `transform(input_len: u32) -> i32`
  - `-1` invalid (banned content, malformed)
  - `0` no changes needed; input is already deterministic
  - `>0` output length written to `output_buffer()`

Validation = `transform(...) == 0`.

## Build

```
deno task build-determinism-constants   # regenerate src/well_known.zig if Block.ts constants change
deno task build-determinism-tool        # builds both wasm-determinism.wasm and wasm-determinism-contract.wasm
deno task build-determinism-fixtures
deno test --allow-read tests/WasmDeterminism.test.ts tests/WasmDeterminismContract.test.ts
```

Both artifacts at `bin/wasm-determinism.wasm` and
`bin/wasm-determinism-contract.wasm` are checked in. Run the build task
before sending a PR if you've changed any Zig source.

## Contract deployment

The Scaffold contract uses these on its introducing block:

| Record key                    | Value                                          |
|-------------------------------|------------------------------------------------|
| `modules`                     | JSON ModulesSpec referencing the contract WASM |
| `output_namespaces`           | `RECORD_CONTRACT` (32 bytes)                   |
| `scaffold-determinism-mode`   | `"transform"` or `"verify"` (UTF-8)            |

The contract takes a 32-byte verifier params: the input WASM's hash.

- **Transform mode** -- loads the input WASM via
  `fetch({ HASH_CONTRACT, input_hash }, "default")`, runs the transform,
  then emits:
  - `(RECORD_CONTRACT, "default")` body = output hash (= input hash if no-op)
  - `(RECORD_CONTRACT, "outputWasmBytes")` body = transformed bytes (only
    if transform changed anything)
  Banned input -> `reject`.
- **Verify mode** -- loads the input WASM the same way and accepts only if
  transform is a no-op (i.e., input is already deterministic). Anything
  else -> `reject`. Emits no outputs.

Two contract blocks deploy the same WASM blob, differing only in the
`scaffold-determinism-mode` record.

## Implemented

- **Banned-content detection** -- atomics (`0xfe` family), relaxed SIMD
  (`0xfd 0x100`..`0x113`), all SIMD ops with float-lane potential
  (everything under the `0xfd` prefix except byte-level v128 loads, stores,
  load_lane/store_lane, load_zero, and v128.const), GC (`0xfb` family),
  exception handling (`try_table`, `throw`, `throw_ref`, legacy try/catch),
  reinterpret family (`f32.reinterpret_i32` etc.), shared memory/table.
- **Memory section -> import rewrite** -- if a module declares its own
  memory, it's rewritten to import `env.memory` instead. The transformer
  preserves limits.
- **`memory.grow` / `table.grow` abstain guard** -- after each grow site,
  the transformer inserts a guard: if `result == -1`, the contract calls
  `env.abstain` and traps via `unreachable`. The contract must import
  `env.abstain (func)`; if not, the validator rejects with -1.
- **NaN canonicalization at observable escapes** -- the transformer inserts
  a 6-instruction canonicalize sequence before every observable bit-leak
  point: `f32.store`, `f64.store`, `f32.copysign` (second arg), and
  `f64.copysign` (second arg). NaN bit pattern is normalized to
  `0x7fc00000` (f32) / `0x7ff8000000000000` (f64). Internal storage points
  (`local.set` / `global.set`) and function returns are NOT canonicalized
  -- bits cannot escape through those paths within WASM execution. Hosts
  that bit-read return values should use a memory-out contract API.
- **Custom version section** -- `scaffold-transform-version: 20250510`
  appended to mark transformed modules.
- **Idempotence** -- running the tool on its own output returns 0. Output
  bytes are byte-deterministic for a given input.

## Not yet implemented

- **Integer-typed SIMD ops** are blocked by the broad SIMD ban. A v128
  carrying only integer lanes is deterministic, but without an operand
  stack type tracker the validator can't distinguish "v128 from integer
  ops only" from "v128 that contains float lanes." The safer current
  behavior is to ban all SIMD arithmetic / lane-access / comparison ops
  outright. Future work: add the type tracker and re-enable safe integer
  SIMD via a per-op rule.

A contract that uses only scalar f32/f64 arithmetic plus copysign is
fully covered. SIMD contracts are entirely rejected until the type
tracker arrives.
