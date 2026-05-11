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
- **Custom version section** -- `scaffold-transform-version: 20250510`
  appended to mark transformed modules.
- **Idempotence** -- running the tool on its own output returns 0 (no
  changes). Output bytes are byte-deterministic for a given input.

## Not yet implemented

- **NaN canonicalization at float escape ops.** The transformer does *not*
  yet insert canonicalization sequences at `local.set`/`local.tee`/
  `global.set`/`*.store`/`call`/`return`/`br*` for float operands. A module
  that uses float arithmetic and then escapes the result via memory or
  function boundary still has nondeterministic NaN bits. See plan doc.
- **Operand stack type tracker** -- needed for the multi-value `br*`
  canonicalize case and for call-args/return canonicalization.

Until NaN canonicalization lands, the host runtime should treat contracts
with float types as conditionally deterministic: the validator passes
the banned-content checks but does not yet enforce canonicalization.
