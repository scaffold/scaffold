# wasm-determinism

Single idempotent tool that validates + transforms a WASM module to make
it execute deterministically in any engine. Used by Scaffold to gate
contracts before they enter the network.

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
deno task build-determinism-tool
deno task build-determinism-fixtures
deno test --allow-read tests/WasmDeterminism.test.ts
```

The artifact at `bin/wasm-determinism.wasm` is checked in. Run the build
task before sending a PR if you've changed any Zig source.

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
