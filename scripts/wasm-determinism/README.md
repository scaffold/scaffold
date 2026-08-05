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

## WasmGC

The `0xfb` ban is a resource-exhaustion decision, not a "GC is
nondeterministic" decision, and it is liftable. Recorded here so it
isn't relitigated from scratch.

Most of what makes a collector nondeterministic is absent from WasmGC by
construction. The MVP offers no way to obtain an address, no
reference-to-integer conversion (`i31` only goes the other way), and no
byte view of a struct. Finalizers, weak references, heap introspection,
allocation control and shared cross-thread references are all deferred
post-MVP. Consequences: GC timing is unobservable (core wasm has no
clock and we expose none), object layout is unobservable, and a language
needing identity hash codes is *forced* to store a counter-assigned
field rather than hash an address. `ref.eq` is identity comparison, and
`i31` refs with equal values compare equal. A NaN in a struct or array
field cannot leak its bits without `reinterpret` (banned) or an
`f64.store` (already canonicalized), so float fields need no new
canonicalization points.

What is actually nondeterministic:

- **Allocation failure.** The GC MVP spec defines no OOM semantics at
  all. Engines differ (wasmtime traps with "allocation too large"; V8
  does its own thing), and the failure point depends on heap limits,
  per-object header overhead and collector efficiency.
- **Engine static limits.** V8's `wasm-limits.h` carries
  `kV8MaxWasmStructFields = 999`, `kV8MaxWasmArrayInitLength = 999` and
  `kV8MaxRttSubtypingDepth = 31`, explicitly marked as not standardized.
  This diverges at *validation* time, so a module could be accepted by
  one peer and rejected by another before it ever runs.
- **Stack depth.** Pre-existing, but GC'd languages traverse linked
  structures recursively and hit engine limits far more often.

The `memory.grow` abstain guard does not transfer. `memory.grow` returns
-1, a value we can branch on; allocation failure traps, and wasm traps
are uncatchable from inside wasm -- exception handling does not catch
traps either. Letting it trap and having the host classify OOM would
make consensus depend on three engines agreeing on how they report OOM.

Lifting the ban therefore means pre-emptive metering:

1. A protocol cost model: a struct of type T costs H + sum of field
   sizes, H a fixed notional header, independent of any engine's real
   layout. Same footing as EVM gas.
2. An allocation counter injected before each `struct.new` /
   `array.new*`, charged against a protocol budget set below the
   smallest engine limit, then `abstain` + `unreachable`. Array cost
   needs the runtime length off the operand stack, so this is codegen,
   not a peephole insert.
3. Protocol static limits below every engine's (struct fields, array
   init length, subtyping depth), rejected at validation.

All three need the type section parsed -- rec groups, subtyping chains,
field types, resolving the type index at each allocation site. That is
the same type-aware pass integer SIMD needs above.

The remaining argument against is not mechanical: under WasmGC the
allocator stops being bytes we hashed and becomes the host engine's
collector, which we cannot audit or version-pin, so a V8 behaviour
change becomes a consensus fork. Against that, lifting it unblocks
Kotlin, Dart, Scala, OCaml, Java (TeaVM) and Scheme (Hoot), all of which
ship no GC of their own and are correspondingly smaller.
