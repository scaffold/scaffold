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

The artifact at `dist/wasm-determinism.wasm` is checked in. Run the build
task before sending a PR if you've changed any Zig source.

## V1 scope (this release)

Implemented:

- **Banned-content detection** -- atomics (`0xfe` family), relaxed SIMD
  (`0xfd 0x100`..`0x113`), GC (`0xfb` family), exception handling
  (`try_table`, `throw`, `throw_ref`, legacy try/catch), reinterpret family
  (`f32.reinterpret_i32` etc.), shared memory/table.
- **Memory section -> import rewrite** -- if a module declares its own
  memory, it's rewritten to import `env.memory` instead. The transformer
  preserves limits.
- **Custom version section** -- `scaffold-transform-version: 20250510`
  appended to mark transformed modules. Idempotent on re-run.
- **Idempotence** -- running the tool on its own output returns 0 (no
  changes). Output bytes are byte-deterministic for a given input.

## Not yet implemented (V2)

- **NaN canonicalization at float escape ops.** The transformer does *not*
  yet insert canonicalization sequences at `local.set`/`local.tee`/
  `global.set`/`*.store`/`call`/`return`/`br*` for float operands. A module
  that uses float arithmetic and then escapes the result via memory or
  function boundary still has nondeterministic NaN bits. See plan doc.
- **`memory.grow` / `table.grow` abstain guard.** The transformer does
  *not* yet wrap grow instructions to call `env.abstain` on `-1`. Grow
  results currently propagate as-is; this works deterministically only if
  the host pins `min == max` on the imported memory.
- **Operand stack type tracker** -- needed for the multi-value `br*`
  canonicalize case and for call-args canonicalization.

These are the next steps. Until they land, contracts that use floats
or `memory.grow` should not rely on the V1 validator for full determinism
guarantees -- they pass the banned-content checks but the runtime needs
to enforce min == max imports and only allow no-NaN-producing float code.
