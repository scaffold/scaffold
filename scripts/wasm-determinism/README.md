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
- **NaN canonicalization at float escape ops (partial)** -- the transformer
  inserts a 6-instruction canonicalize sequence (canonical-NaN-on-NaN)
  before every f32/f64 `local.set`, `local.tee`, `global.set`, `f32.store`,
  and `f64.store`. NaN bit pattern is normalized to `0x7fc00000` (f32) /
  `0x7ff8000000000000` (f64) on escape.
- **Custom version section** -- `scaffold-transform-version: 20250510`
  appended to mark transformed modules.
- **Idempotence** -- running the tool on its own output returns 0. Output
  bytes are byte-deterministic for a given input.

## Not yet implemented

- **NaN canonicalization at call args, return values, br\* with floats,
  v128 stores.** These escape ops are not yet canonicalized. Call/return
  needs to spill float arguments to locals before canonicalizing (one
  scratch per arg). `br*` and multi-value blocks need an operand-stack
  type tracker. `v128.store` (and `v128.store*_lane`) needs lane-wise
  canonicalization via `f32x4.eq` / `f64x2.eq` + `v128.bitselect`.
- **Operand stack type tracker** -- needed for the `br*`-with-float case
  and for verifying call/return canonicalization is applied to the right
  operands.

A contract that only uses floats inside straight-line arithmetic with
results stored to locals/globals/memory is fully covered. A contract that
passes f32/f64 across function boundaries is not yet covered -- the host
should treat such contracts as conditionally deterministic and refuse to
include them in consensus blocks.
