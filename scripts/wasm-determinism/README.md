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
  (`0xfd 0x100`..`0x113`), GC (`0xfb` family), exception handling
  (`try_table`, `throw`, `throw_ref`, legacy try/catch), reinterpret family
  (`f32.reinterpret_i32` etc.), shared memory/table.
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

- **v128 lane-wise canonicalization** at `v128.store`, `v128.store*_lane`,
  `i32x4.extract_lane`, `i64x2.extract_lane`. A v128 containing float
  lanes can leak bits through these escape points. Pattern would be a
  back-to-back `f32x4.eq` + `v128.bitselect` then `f64x2.eq` +
  `v128.bitselect` (~12 instructions per site). Contracts using v128 with
  float lanes should be flagged as conditionally deterministic until this
  lands.

A contract that uses only scalar f32/f64 arithmetic plus copysign is
fully covered for determinism. SIMD-using contracts that mix integer
and float lanes are not yet covered.
