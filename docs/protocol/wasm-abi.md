# WASM Contract ABI

> Status: design draft. Not yet implemented. The conceptual surface lives in [computation.md](computation.md) and [output-data.md](output-data.md); this document is the concrete binary contract a WASM module must satisfy to run as a Scaffold contract, plus the host-side runtime obligations that make the same WASM module portable across transports (worker + Atomics, or main-thread + JSPI).

## Goals

A contract author writes one WASM module. The module:
- Implements verification (and optionally generation) of a spending condition.
- Optionally implements walker/builder methods so generic UIs can read and write the contract's `verifier.params` and `output.data`.
- Sees a single, transport-agnostic, **synchronous** host surface. Whether the runtime delivers host calls via `Atomics.wait` over `SharedArrayBuffer` (default, works everywhere with COOP/COEP) or via JSPI (`WebAssembly.Suspending` / `WebAssembly.promising`, faster on supporting browsers) is an implementation detail.

The ABI is the union of:
- Required and optional **module exports** the host calls into.
- Required **host imports** the module may call out to.
- A **wire format** for every value that crosses the boundary.
- An **error model** for rejection vs crash.

## Determinism

A contract that runs on two honest peers must produce the same outputs and the same accept/reject decision. This is non-negotiable: it is what lets peers agree on which blocks are valid without re-running the contract centrally.

Three rules follow:

1. **All host imports are synchronous from the contract's view.** A contract has no way to observe whether a particular call blocked or not, no way to time anything, no way to detect transport. Two runtimes (one Atomics, one JSPI) executing the same contract over the same block see the same return values in the same order.
2. **Host imports must be pure functions of the block's content.** They read from the block, the contract's params, and the contract's input claims — never from wall-clock time, RNG, network state, or peer-local config. (The one external input — `timestamp` — is the *block's* timestamp, fixed at signing time, not the local clock.)
3. **Contracts must use only deterministic WASM features.** No `bulk-memory` non-determinism, no SIMD with NaN canonicalisation gaps, no threads-besides-the-shared-memory-model-the-runtime-provides. Future revisions will pin a precise feature whitelist; for now, target wasm32 baseline + the imports listed below and you're safe.

Crashes are also deterministic: a contract that traps on input X traps on input X for every honest peer. The runtime never injects timeouts that vary between peers (the budget mechanism in `ContractVerificationModule` is a per-peer overspend protection, not a determinism source — exceeding budget is a configuration/incentive problem, not a verification result).

---

## Module Layout

### Required exports

```
(memory $memory ...)                     // exported memory (or imported, see below)
(func $alloc (param i32) (result i32))   // bump-style allocator; returns a pointer
```

- `memory` is the contract's linear memory. The runtime requires it to be **shared** (`SharedArrayBuffer`-backed) when running under the Atomics transport. Under JSPI it may be unshared.
  - The runtime accepts either an exported memory or an imported `(import "env" "memory" (memory ...))`. If exported, the runtime detects shared-vs-unshared and picks a transport. If imported, the runtime supplies a memory of the requested kind.
  - Initial size convention: 16 pages (1 MiB). Maximum: read from block metadata `max_memory_pages` (see [Block-level contract metadata](#block-level-contract-metadata)); falls back to 4096 pages (256 MiB) when unspecified.
- `alloc(size)` returns a pointer to `size` writeable, zeroed bytes. It must succeed or trap. Never freed; modules are short-lived. Authors using AssemblyScript or Rust can wrap their language's allocator; minimal hand-written modules ship a bump allocator.

Static facts about the contract — its output namespaces, ABI version, resource limits — do **not** live as WASM exports. They live as record outputs on the contract's introducing block (see [Block-level contract metadata](#block-level-contract-metadata)). The WASM module focuses on execution; metadata is data that other peers can read without instantiating the module.

### Optional exports

The host calls these only if present. Each corresponds 1:1 to a method on `Contract` (see `src/contracts/Contract.ts`).

```
(func $run)                                                    // entry point for verification/generation
(func $walk_params  (param i32 i32))                           // (params_ptr, params_len)
(func $walk_data    (param i32 i32))                           // (data_ptr,   data_len)
(func $build_params (result i64))                              // returns packed (result_ptr, result_len)
(func $build_data   (result i64))                              // returns packed (result_ptr, result_len)
```

A contract that exports neither `walk_*` nor `build_*` falls back to raw-hex display in generic tools. A contract that does not export `run` cannot be used as a verifier — the runtime rejects load.

### Packed pointer return

Several exports and imports return variable-length bytes into the contract's memory. The convention:

```
i64 packed = ((u64)(ptr as u32) << 32) | ((u64)(len as u32))
```

To unpack: `ptr = (i64 >> 32) as u32`, `len = (i64 & 0xffff_ffff) as u32`. A return of `0` means "no result" (ptr=0, len=0). For exports, the runtime treats the returned region as borrowed for the duration of the host's use; the contract must not call any code that mutates `memory[ptr..ptr+len]` until the host has finished. Since exports run synchronously from the host's view, this is automatic for export returns.

For imports, the runtime is responsible for ensuring the bytes the contract sees at `(ptr, len)` were allocated by calling the module's `$alloc` so the contract may keep using them. See [Async-bridge transport](#async-bridge-transport).

---

## Block-level Contract Metadata

A contract is published as a block whose record outputs include the WASM binary plus the contract's static metadata. None of this metadata is a WASM export — peers fetch it by reading the block, no execution required.

Standard records on the contract block:

| Record key | Wire format | Meaning |
|---|---|---|
| `modules`           | UTF-8 JSON object (see [Stacking](#stacking)) | Required on every WASM contract block. Describes the contract's module graph: a `base` section (ABI version + scaffold-facing entry points) and a `layers` map of named modules with their cross-edge linking. Each layer references a content-addressed WASM blob (fetched via `{ contract: HASH_CONTRACT, params: blobHash }`). Every cross-module / cross-scaffold reference is explicit; no implicit defaults. Replaces the legacy `wasm`, `wasm_hashes`, and `abi_version` records. |
| `output_namespaces` | concatenated 32-byte hashes (no length prefix; total length is the count × 32) | The closed set of contract hashes this contract may produce. Empty record (zero bytes) = produces no outputs. See [computation.md#output-namespaces](computation.md#output-namespaces). |
| `max_memory_pages`  | little-endian `u32`      | Per-memory cap in 64 KiB pages applied to every memory (scaffold-provided or module-declared) instantiated for the contract. Defaults to `4096` (256 MiB) when absent. |
| `budget_ms_hint`    | little-endian `u32`      | Author's hint for `runVerifying` wall-clock budget. The runtime uses this only to size scheduling; the actual budget enforcement comes from the verification module (see [computation.md#per-verifier-budget](computation.md#per-verifier-budget)). |

Additional contract-specific records may be present; the runtime ignores anything it doesn't recognise.

---

## Wire Format

All multi-byte integers are little-endian, matching WASM's native representation.

### Primitives

| Spec name | Size | Encoding |
|---|---|---|
| `u8`     | 1 | unsigned byte |
| `u32`    | 4 | little-endian unsigned 32-bit |
| `i64`    | 8 | little-endian two's-complement 64-bit |
| `i128`   | 16 | little-endian two's-complement 128-bit; coin amounts |
| `bytes`  | `4 + n` | `u32 len; byte[len] data` |
| `hash`   | 32 | raw 32-byte digest (no length prefix; size is fixed) |
| `string` | `4 + n` | `u32 len; byte[len] utf8` |

All coin values (`Output.value`, `Claim.value`, the `value` field returned by `request_body`) are `i128`. WASM has no native i128 type; values cross the boundary as 16 bytes inside a serialised struct (the convention everywhere in this spec) — no i128-aware import signatures needed. The TS-side adapter marshals to and from `BigInt`.

### `Verifier`

```
Verifier {
    contract: hash      // 32 bytes
    params:   bytes     // u32 len + bytes
}
```
Total wire size: `36 + params.len`.

### `Claim`

The shape a contract sees from `claim_next` / `claim_all`. Body-less outputs (`Output.body` omitted in the protocol) are filtered out by the runtime before they reach the contract — see [computation.md#data-less-outputs](computation.md#data-less-outputs) — so `Claim.body` is always present here.

```
Claim {
    verifier:      Verifier   // 36+ bytes
    value:         i128       // 16 bytes
    body:          bytes      // u32 len + bytes
    is_self_claim: u8         // 0 or 1
}
```

For `claim_all`, the wire format is `u32 count` followed by `count` consecutive `Claim` records.

### `Output` (input to `emit_output`)

```
Output {
    verifier: Verifier
    value:    i128
    data:     bytes
}
```

### `ValueDescriptor` (walker / builder)

A JSON-encoded `string` matching the schema in [output-data.md#value-descriptors](output-data.md#value-descriptors):

```json
{ "type": "bytes/public_key/ed25519", "shortDescription": "Owner public key" }
```

The host parses on receipt. Contracts using the AssemblyScript / Rust SDKs build descriptors with helper functions; raw-WASM authors emit JSON manually.

---

## Host Import Surface

Three modules of imports. A contract imports only what it uses; unused imports are not required.

### `scaffold_env.*` — execution environment

Mirrors `ContractEnv` (`src/core/ContractEnv.ts`). Calls marked **(may block)** can suspend the contract while the host fulfils them; see [Async-bridge transport](#async-bridge-transport).

| Import | Signature | Returns | Notes |
|---|---|---|---|
| `mode`              | `() -> i32` | `0` = generation, `1` = verification | Synchronous. |
| `contract_hash`     | `() -> i64` | packed `(ptr, len)` to a 32-byte hash region | Synchronous. Allocated via `$alloc` once per call. |
| `contract_metadata` | `(verifier_ptr: i32, verifier_len: i32) -> i64` | packed `(ptr, len)` of `i128 value + bytes body` | Read-only lookup against the **contract's own block** (the block whose hash equals the running contract's hash). Used for retrieving record outputs and other metadata baked into the contract definition: `output_namespaces`, `abi_version`, source bytes for interpreter-stack contracts, etc. — see [Block-level contract metadata](#block-level-contract-metadata). Determinism holds because contract blocks are content-addressed and immutable. Throws via `reject` if the contract block is not loaded or no matching output exists. |
| `params`            | `() -> i64` | packed `(ptr, len)` of `verifier.params` bytes | Synchronous. |
| `timestamp`         | `() -> i64` | block timestamp, ms since epoch | Synchronous. |
| `claim_next`        | `() -> i64` | packed `(ptr, len)` of one `Claim` wire record | **may block** in generation; throws via `reject` if no matching claim in verification. |
| `claim_all`         | `(limit: i32) -> i64` | packed `(ptr, len)` of `u32 count + count × Claim` | **may block** in generation. `limit = -1` for unbounded. |
| `emit_output`       | `(out_ptr: i32, out_len: i32) -> ()` | — | Argument is an `Output` wire record. Synchronous from contract's POV; verification mode validates against the namespace sequence. To emit a self-claimed record output (the equivalent of TS-side `env.record(key, value)`), build an `Output` whose `verifier.contract` is `RECORD_CONTRACT`, `verifier.params` is the key, `value` is `0`, and `body` is the value. |
| `request_body`      | `(verifier_ptr: i32, verifier_len: i32) -> i64` | packed `(ptr, len)` of `i128 value + bytes body` | **may block** in generation. The returned bytes are the host's resolved `(value, body)` pair. Contracts must not depend on `value` being final: the block-creation layer may raise it during solidification (see [computation.md#output-requirements](computation.md#output-requirements) "solidification-time value override"). This is a known temporary mechanism; future revisions will fold value resolution into the contract path. |
| `fetch`             | `(verifier_ptr: i32, verifier_len: i32, key_ptr: i32, key_len: i32) -> i64` | packed `(ptr, len)` of the record value bytes | **may block**. Throws via `reject` if no ancestor block claims the verifier. |
| `put`               | `(verifier_ptr: i32, verifier_len: i32, records_ptr: i32, records_len: i32) -> ()` | — | Spawn an independent sub-contract. Verification: no-op. **may block** in generation: waits for the sub-contract's block to commit, propagates `ContractRejection` from the sub-generator. See [Put](#put). |
| `sign`              | `(pubkey_ptr: i32, pubkey_len: i32) -> ()` | — | Asserts the block was signed by `pubkey`. Synchronous. |
| `reject`            | `(reason_ptr: i32, reason_len: i32) -> noreturn` | — | Aborts the contract with a `ContractRejection`. Bytes are interpreted as UTF-8. The runtime traps after the call so any further WASM execution is impossible; conventionally callers also `unreachable` immediately after for compilers that don't infer noreturn. |

### `scaffold_walker.*` — walker host (only meaningful inside `walk_params` / `walk_data`)

| Import | Signature | Returns |
|---|---|---|
| `emit_bytes`     | `(key_ptr, key_len, value_ptr, value_len, desc_ptr, desc_len: i32) -> ()` | — |
| `emit_string`    | `(key_ptr, key_len, value_ptr, value_len, desc_ptr, desc_len: i32) -> ()` | — |
| `emit_number`    | `(key_ptr, key_len: i32, value: f64, desc_ptr, desc_len: i32) -> ()` | — |
| `emit_bool`      | `(key_ptr, key_len: i32, value: i32, desc_ptr, desc_len: i32) -> ()` | — |
| `emit_map_start` | `(key_ptr, key_len: i32) -> i32` | `0` = host wants to skip this branch, `1` = continue |
| `emit_map_end`   | `() -> ()` | — |
| `emit_list_start`| `(key_ptr, key_len, count: i32) -> i32` | `0` = skip, `1` = continue |
| `emit_list_end`  | `() -> ()` | — |

A contract calling a walker import outside an active `walk_*` invocation traps. (Enforced by the runtime; the host's emit handler is null otherwise.)

### `scaffold_builder.*` — builder host (only meaningful inside `build_params` / `build_data`)

| Import | Signature | Returns |
|---|---|---|
| `request_bytes`        | `(key_ptr, key_len, desc_ptr, desc_len: i32) -> i64` | packed `(ptr, len)` of the user-supplied bytes (or default) |
| `request_string`       | `(key_ptr, key_len, desc_ptr, desc_len: i32) -> i64` | packed `(ptr, len)` of UTF-8 |
| `request_number`       | `(key_ptr, key_len, desc_ptr, desc_len: i32) -> f64` | numeric value |
| `request_bool`         | `(key_ptr, key_len, desc_ptr, desc_len: i32) -> i32` | `0` or `1` |
| `request_array_length` | `(key_ptr, key_len, desc_ptr, desc_len: i32) -> i32` | item count |
| `begin_object`         | `(key_ptr, key_len: i32) -> ()` | — |
| `end_object`           | `() -> ()` | — |
| `begin_array`          | `(key_ptr, key_len: i32) -> ()` | — |
| `end_array`            | `() -> ()` | — |
| `validation_error`     | `(key_ptr, key_len, msg_ptr, msg_len: i32) -> ()` | — |

The builder result is the packed `(ptr, len)` returned from `$build_params` / `$build_data` itself — there is no separate `set_result` import.

---

## Error Model

Three distinct outcomes:

1. **Accept.** The contract's exported function returns normally. For `run`, this means the spending condition is satisfied (verification) or the draft has been built (generation). For walker/builder exports, the returned bytes (if any) are the result.

2. **Reject.** The contract calls `scaffold_env.reject(reason_ptr, reason_len)` and traps. The runtime surfaces this as a `ContractRejection` with the reason as a UTF-8 string. This is the *intended* failure path — peer nodes treat this as a normal "contract said no" signal.

3. **Crash.** Any other trap — `unreachable`, divide-by-zero, OOB memory access, growing memory past the limit, calling an import out of context (e.g. a builder import outside `build_*`), exceeding the per-call budget. The runtime surfaces this as a generic execution error. Peers treat crashes the same as rejections for the purpose of accepting/rejecting the block, but log differently and may downgrade the publishing peer's reputation more aggressively because crashes typically indicate a buggy contract or malicious input rather than an honest disagreement.

`scaffold_env.reject` is preferred over a plain `unreachable` because the reason string is preserved across the bridge and shows up in logs and the explorer UI. Compilers that don't recognise the import as `noreturn` should emit `unreachable` immediately after the call to satisfy the typechecker; the runtime never returns from `reject`.

---

## Async-bridge Transport

This is where the ABI's signatures are deliberately decoupled from how blocking happens. From the contract's view, every "may block" import looks like a normal synchronous WASM call: the contract supplies arguments, the host produces a return value, execution continues. The runtime implements that synchrony in one of two ways.

### Default: Atomics over SharedArrayBuffer

The contract runs in a Worker. Its memory is `SharedArrayBuffer`-backed. Each instance has a per-call signal buffer and a result-staging buffer.

For a may-block call:
1. Contract calls (e.g.) `scaffold_env.claim_next()`. The Worker-side host stub serialises arguments (none in this case), copies them into the staging buffer, sets the signal flag to `WAIT`, posts a message to the main thread, and calls `Atomics.wait` on the signal buffer.
2. The main thread receives the message, runs the corresponding async `ContractEnv` method, awaits the result, and copies the serialised bytes into the staging buffer (chunked if larger than the buffer).
3. The main thread sets the signal flag to `CONTINUE` (or `THROW` for `ContractRejection`) and `Atomics.notify`s.
4. The Worker wakes. On `THROW` it triggers `scaffold_env.reject` semantics in-process. On `CONTINUE` it calls the contract's exported `$alloc(len)`, copies the staged result into contract memory, and returns the packed `(ptr, len)` to the caller.

This is the same pattern as the existing `src/worker/WorkerChannel.ts` (currently scoped to a small filesystem-style protocol). The new ABI requires extending it to:
- Carry argument and result *bytes* in addition to the existing `i32` numeric results.
- Allocate via the contract's `$alloc` on the Worker side after wake.
- Distinguish `THROW` for rejection vs crash.

Requirements: cross-origin isolation (`COOP: same-origin` + `COEP: require-corp`). The demo's `vite.config.ts` will need a small dev-server middleware to set these.

### Optional: JSPI

When the runtime detects JSPI support (`typeof WebAssembly.Suspending === 'function'`) and the contract module's memory is unshared (or the runtime is configured to instantiate it unshared), it may use JSPI instead.

For each may-block import, the host wraps an async JS function:

```js
const claimNext = new WebAssembly.Suspending(async () => {
  const claim = await env.claimNext();
  const bytes = encodeClaim(claim);                   // serialise to wire format
  const ptr = instance.exports.alloc(bytes.length);   // allocate in contract memory
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return (BigInt(ptr) << 32n) | BigInt(bytes.length); // packed return
});
```

The exported entry point is wrapped with `WebAssembly.promising`:

```js
const promisingRun = WebAssembly.promising(instance.exports.run);
await promisingRun();
```

From the contract's side, `claim_next` looks identical to the Atomics version — it returns an `i64` with the packed pointer. The runtime stack-switches to await the JS Promise; no Worker, no SAB, no `postMessage`, no COOP/COEP requirement.

JSPI is a fast path opportunity, not a replacement: as of the spec date, it ships in Chrome 137+, is behind a flag in Firefox, and is not available in Safari. The runtime picks Atomics by default and uses JSPI only when feature detection succeeds and the deployment opts in.

### Constraints common to both transports

- **Re-entrancy from imports back into exports is allowed.** The runtime calls `$alloc` from inside an import handler. Contracts must not assume that a single import call observes a quiescent module state.
- **Import calls are serialised per-instance.** The contract is single-threaded; the runtime never invokes two imports concurrently on the same instance.
- **Per-call CPU/memory budget.** The runtime enforces a per-`run` budget derived from `ContractVerificationModule`'s `budgetMs` (see [computation.md#per-verifier-budget](computation.md#per-verifier-budget)). Exceeding it is a crash. Memory growth past the per-contract maximum is a crash.

---

## Composition

Two mechanisms for composing contracts. They serve different needs and compose orthogonally — stacked contracts can call `put`; sub-contracts spawned by `put` can be stacks.

| | **Stacking** | **Put** |
|---|---|---|
| Purpose | Static, in-band, low-overhead composition | Dynamic, out-of-band, parallel composition |
| Granularity | Multiple WASM blobs in one execution | Independent generator producing its own block |
| Configured | At contract publication, via `modules` record on the contract block | At runtime, via `put()` host call during generation |
| Communication | Direct WASM-to-WASM (exports↔imports), shared memory | One-shot pre-resolution via a records vector; no further interaction |
| Budget | Stack shares the parent's per-verifier budget | Each `put` gets its own fresh budget |
| Verification | Single block, single verifier — stack is internal | Sub-contract block is independently verified |

### Stacking

A contract is structured as a **graph of WASM modules**, declared in a `modules` JSON record on the contract block. The graph has two parts:

- **`base`**: the scaffold-facing stub. Names which layer scaffold invokes for each mode (`run`, `walk_params`, etc.) and carries the contract's ABI version. Scaffold itself is a node in the graph, addressed by the special layer key `"base"`.
- **`layers`**: a map from a logical layer key (e.g. `"wasi_shim"`, `"program"`) to a layer spec. Each layer references a content-addressed WASM blob and lists how its declared WASM imports resolve onto other layers' exports.

Every cross-edge in the graph is **explicit** in some layer's `imports` map. There is no global lookup, no implicit default, no fallback. Authors spell out exactly where each import comes from.

**Wire format.**

```ts
type ModulesSpec = {
  base: {
    version: number;                          // integer ABI date, e.g. 20250510
    imports: Record<string, string>;          // "<mode>" -> "<layerKey>:<exportName>"
    memories?: Record<string, MemorySpec>;    // scaffold-provided memories, addressable as "base:<name>"
  };
  layers: Record<string, {
    wasmHash: string;                         // 64-char hex content hash of the WASM blob
    imports?: Record<string, string>;         // "<ns>.<field>" -> "<layerKey>:<exportName>"
  }>;
};

type MemorySpec = {
  initial: number;                            // initial size in 64-KiB pages
  maximum?: number;                           // max pages; defaults to the contract block's max_memory_pages
  shared?: boolean;                           // true => SAB-backed (required for Atomics transport)
};
```

The values of every `imports` map are `"<layerKey>:<exportName>"` references. `layerKey` is any key in `layers`, or the reserved string `"base"` (referring to scaffold's mode-appropriate ContractEnv host exports and any memories declared in `base.memories`).

Imports may resolve to **any kind** that WASM imports support: function, memory, table, or global. The linker reads the import kind from `WebAssembly.Module.imports()` and matches it against the resolved target's kind; a mismatch (e.g. memory import resolving to a function) is a `LinkError` at load time. In practice, function and memory imports are the only kinds modern toolchains emit.

**Wildcards.** `imports` entries support a single trailing-`*` wildcard:

```jsonc
{ "wasi_snapshot_preview1.*": "wasi_shim:*" }
```

This matches any import whose key starts with `"wasi_snapshot_preview1."`; the suffix replaces the `*` in the target. Required shape:
1. `*` is at the end of BOTH key and value.
2. The character immediately before `*` is `.` in the key, and either `.` or `:` in the value.

Resolution priority: literal entries first, then longest-prefix wildcard.

**Strictness.** If a declared WASM import on any layer has no matching entry (literal or wildcard) in the layer's `imports`, loading fails. There are no implicit defaults.

**Structural rules** (enforced at parse time):
1. `modules.base.version` is an integer.
2. `modules.layers` is non-empty.
3. Every layer's `wasmHash` is a 64-char hex string.
4. No duplicate `wasmHash` across layers.
5. The reserved layer key `"base"` cannot appear in `layers`.
6. Every `"<layerKey>:<exportName>"` reference resolves to a layer that exists in `layers` (or to `"base"`).
7. `base.imports` references cannot target `"base"` (scaffold doesn't call itself).
8. Memory imports across layers must form an acyclic dependency graph (see [Memory model](#memory-model-stacking) below). Function-import cycles are handled by JS forwarders; memory-import cycles cannot be (memories aren't lazy-bindable) and are rejected at load.

**Worked examples.**

Single-module contract that imports scaffold's memory:

```jsonc
{
  "base": {
    "version": 20250510,
    "imports": { "run": "main:run" },
    "memories": {
      "heap": { "initial": 16, "maximum": 4096, "shared": true }
    }
  },
  "layers": {
    "main": {
      "wasmHash": "...64-hex...",
      "imports": {
        "scaffold_env.*": "base:*",
        "env.memory": "base:heap"
      }
    }
  }
}
```

The contract's WASM declares `(import "scaffold_env" "emit_output" ...)` and `(import "env" "memory" ...)`; the wildcard routes function imports to scaffold's matching exports, and `env.memory` resolves to a scaffold-provided memory. `base.imports.run` says "scaffold's run-mode entrypoint is `main:run`."

Single-module contract that owns its memory (no scaffold-provided memory needed):

```jsonc
{
  "base": {
    "version": 20250510,
    "imports": { "run": "main:run" }
  },
  "layers": {
    "main": {
      "wasmHash": "...64-hex...",
      "imports": { "scaffold_env.*": "base:*" }
    }
  }
}
```

The contract's WASM declares `(memory (export "memory") 16 4096 shared)` — its own memory. Scaffold uses the entry layer's exported `memory` for the host bridge.

A WASI program above a WASI shim (two layers, function-cyclic + memory-acyclic):

```jsonc
{
  "base": {
    "version": 20250510,
    "imports": { "run": "wasi_shim:run" }
  },
  "layers": {
    "wasi_shim": {
      "wasmHash": "...the WASI shim WASM...",
      "imports": {
        "_start": "program:__wasi_unstable_reactor_start",
        "program_mem.memory": "program:memory",
        "scaffold_env.*": "base:*"
      }
    },
    "program": {
      "wasmHash": "...the WASI program WASM...",
      "imports": {
        "wasi_snapshot_preview1.*": "wasi_shim:*"
      }
    }
  }
}
```

Each module declares its own memory. The shim imports the program's exported memory under a local name (so it can read program pointers when forwarding WASI calls). The program imports only the shim's WASI functions. Memory deps are one-way (shim ← program), so topo order is "program first, then shim". Function cycles (shim ↔ program) are resolved by JS forwarders post-instantiation.

`base.imports.run` is `wasi_shim:run` — scaffold calls the shim's `run`, which internally invokes the program's `_start` via the cross-edge import. The shim copies bytes between its own memory and the program's memory at the WASI boundary as needed.

<a id="memory-model-stacking"></a>
**Memory model.** Each layer has its own linear memory. A layer's memory is either declared in the WASM module (`(memory ...)`) or imported via the `imports` map (resolving to another layer's exported memory or a `base.memories` declaration).

Scaffold uses the **entry layer's memory** for the host bridge: `alloc` returns offsets into the entry layer's memory, and import-supplied bytes (e.g. `request_body` results) are written there. Non-entry layers wanting to ship bytes to scaffold (or receive bytes from it) must copy through the entry layer's memory at their own boundary. For most use cases — single-module contracts, or shims that already mediate every host call — this is naturally where the data ends up.

The entry layer's memory must be `shared: true` when the runtime selects the Atomics transport. Layer-declared memories without `shared` are still permitted as long as they're not the entry memory under Atomics; JSPI and in-process transports don't require shared.

**Entry export.** Scaffold invokes the export named by `base.imports[<mode>]` on the layer named there. The same layer must also export:
- `alloc`: the host-bridge allocator (returns offsets in the entry layer's memory).
- `memory`: the linear memory the bridge reads from / writes to. Either declared in the WASM (`(memory (export "memory") ...)`) or re-exported from an imported memory.

**Linker implementation.** The linker performs two passes:
1. **Memory pass.** Topo-sort layers by memory dependencies. Instantiate any `base.memories`, then instantiate layers in topo order: a layer is instantiable once every memory it imports has been created. Memory imports resolve directly to `WebAssembly.Memory` instances; no forwarding.
2. **Function-cycle pass.** Function imports that target a layer not yet instantiated are stubbed with JS forwarders closing over a shared name table populated after every layer has been instantiated. Forwarders cost one JS-hop per cross-edge call; future work may topo-sort the acyclic subset and use direct linking.

**Cycles.** Duplicate `wasmHash` across layers is rejected at load. Memory-import cycles are rejected at load (no forwarder mechanism). Function-import cycles are allowed and handled by forwarders.

**Budget.** A graph execution counts as a single contract execution: the entire graph shares one per-verifier budget.

**`HASH_CONTRACT` integration.** Each layer's `wasmHash` references a content-addressed WASM blob. The runtime fetches each blob via `fetch({ contract: HASH_CONTRACT, params: blobHash })` before instantiation. A block publishing a blob carries a `HASH_CONTRACT/hash(blob)` discovery output (self-claimed; its `run` verifies the preimage) and a `RECORD_CONTRACT/'default'` output whose body IS the blob. The HASH contract reads the `'default'` record via `request({contract: RECORD_CONTRACT, params: 'default'})` and asserts `hash(body) == params`, so misrepresented blobs are rejected at verification.

**Use cases.** WASI binaries (program imports `wasi_snapshot_preview1` from a Scaffold-WASI shim). JavaScript interpreters (program is a thin wrapper that loads JS source from `contractMetadata`; the shim below is QuickJS-as-WASM exposing host imports under standard names). Any "interpreter atop a host shim" pattern.

### Put

A generating contract may spawn an independent sub-contract that runs in its own `ContractEnv` and produces its own block.

**ABI.** From the contract's perspective:

```
put(verifier_ptr: i32, verifier_len: i32, records_ptr: i32, records_len: i32) -> ()
```

The verifier identifies the sub-contract to spawn (its `(contractHash, params)`). The records bytes are a serialised array of `Output` wire records (`u32 count` then `count × Output`) — pre-resolutions the sub-contract's `request` will consume. The JS-level `ContractEnv.put` surfaces these as a `Record<string, Uint8Array | string>` keyed by record name; the bridge translates between the two at the WASM boundary.

**Verification.** No-op. The sub-contract's block is independently verified later via the normal verification path; nothing on the parent block needs to confirm the `put` succeeded.

**Generation.** The runtime spawns a new generator for `verifier` and runs it to completion. The parent's `put` call is **blocking**: it waits for the sub-block to be committed (or for the sub-generator to fail). If the sub-generator rejects, the parent generator also rejects — `put` is not fire-and-forget. Blocking + propagated failure means the parent has a guarantee that, by the time `put` returns, the sub-contract's block exists on the network.

**Records routing.** When the sub-contract calls `request(verifier)`, the runtime first scans the parent-supplied records by verifier-equality. A match returns the record's `(value, body)` and emits an output slot on the sub-contract's block (same as a normal `request`). This is "generation-only pre-resolution that materialises as a slot": the sub-contract's block is self-contained at verification time — no records needed at verify, the slots are already on the wire.

A `request` call with no matching record falls through to the normal handler chain on the sub-contract.

**Sub-contract namespace.** The sub-contract has its own namespace: its claims, outputs, and self-claims live on its block, not the parent's. The parent and sub-contract share no state beyond the verifier and records.

**Auto-emergence and idempotency.** If the sub-contract claims no inputs and no UTXO exists matching the verifier, the runtime creates a self-claimed output under that verifier on the sub-contract's block. The sub-contract's block thus *emerges as a UTXO source* for the verifier. If a UTXO already exists, the sub-contract claims it instead and no new UTXO is created — the data exists on the network exactly once.

**Recursion.** Sub-contracts spawned by `put` may themselves call `put`. The runtime caps depth (default: 16) to prevent malicious unbounded recursion.

**Budget.** Each `put` gets its own fresh per-verifier budget, independent of the parent's. Stacked WASMs *inside* a sub-contract still share that sub-contract's budget.

**Block placement.** No hard rule. The runtime may merge a sub-contract's outputs into the parent's block (if the sub-contract is small) or place them on a new block (if larger). Authors should not depend on either — `put` is a generation directive, not a block-creation guarantee.

**Use cases.** Providing data alongside a hash request: a parent that references a blob via its `modules` graph (e.g. `{ layers: { main: { wasmHash: H } } }`) calls `put({ contract: HASH_CONTRACT, params: H }, [...])` to seed the network with the preimage. The HASH contract's role is purely as a discovery beacon — the caller (e.g. `resolveBlob` in the WASM plugin) verifies hash equality after fetching. Future calls to `fetch({ contract: HASH_CONTRACT, params: H })` find the sub-contract's block. Any other "publish-and-make-available" pattern works the same way.

---

## Examples

### Minimal echo contract (hand-rolled WAT)

A contract that reads its `params` and emits them as a `RECORD_CONTRACT/"echo"` self-claimed output, then accepts. There is no host-level `require_result` — record outputs are emitted via `emit_output` with `verifier.contract = RECORD_CONTRACT`. The TS-side `env.record(key, value)` helper is sugar over the same call.

```wat
(module
  (memory (export "memory") 1 1 shared)
  (import "scaffold_env" "params"      (func $params      (result i64)))
  (import "scaffold_env" "emit_output" (func $emit_output (param i32 i32)))

  ;; bump allocator
  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  ;; -- Pre-built Output prefix at offset 0 (60 bytes total) ----------
  ;; Output wire layout:
  ;;   [ 0..32):  verifier.contract  -- 32-byte RECORD_CONTRACT hash
  ;;   [32..36):  verifier.params length = 4 (u32 LE)
  ;;   [36..40):  verifier.params = "echo"
  ;;   [40..56):  value = 0 (i128 LE, 16 bytes)
  ;;   [56..60):  body length (u32 LE)            -- written at runtime
  ;;   [60..  ):  body bytes                      -- copied at runtime
  ;;
  ;; The 32 bytes of RECORD_CONTRACT hash and the 16 zero bytes of value
  ;; are zero-initialised by the linear memory and overlaid by the runtime
  ;; (the host knows the canonical RECORD_CONTRACT hash); only the params
  ;; segment is baked into the data section here.
  (data (i32.const 32) "\04\00\00\00echo")

  (func (export "run")
    (local $packed i64) (local $src i32) (local $len i32)
    (local.set $packed (call $params))
    (local.set $src    (i32.wrap_i64 (i64.shr_u (local.get $packed) (i64.const 32))))
    (local.set $len    (i32.wrap_i64 (local.get $packed)))

    ;; body length (u32 LE) at offset 56
    (i32.store (i32.const 56) (local.get $len))
    ;; body bytes copied to offset 60
    (memory.copy (i32.const 60) (local.get $src) (local.get $len))

    ;; emit the Output: ptr=0, len = 60 + body_len
    (call $emit_output
      (i32.const 0)
      (i32.add (i32.const 60) (local.get $len)))))
```

Two imports, one export beyond `memory` and `alloc`. The contract's static metadata (its `output_namespaces`, its `wasm` blob) lives on the introducing block as record outputs (see [Block-level contract metadata](#block-level-contract-metadata)) — not as WASM exports. The first runtime smoke test (DEV_DEMO_TASKS §C0) targets this exact shape.

### Signature contract walker (AssemblyScript)

```typescript
// build with: asc walker.ts -O3 --runtime stub
import { emit_bytes } from "./scaffold_walker";

const DESC = String.UTF8.encode(JSON.stringify({
  type: "bytes/public_key/ed25519",
  shortDescription: "Owner public key",
}));

export function walk_params(ptr: i32, len: i32): void {
  const desc = changetype<usize>(DESC) as i32;
  emit_bytes(0, 0, ptr, len, desc, DESC.byteLength);
}
```

---

## Implementation Notes

These are non-normative: a future implementation may differ as long as the contract-visible behaviour matches.

- **WorkerChannel needs extension.** The current `src/worker/WorkerChannel.ts` signals only two `i32` slots and assumes results fit in one. The new ABI needs:
  - A staging buffer (separate `SharedArrayBuffer`) sized large enough for typical results, with a chunking protocol for larger ones.
  - On dispatch, the worker waits for both a signal-flag transition and an i32 length code.
  - The `THROW` flag is split into `THROW_REJECT` (carry a reason string in the staging buffer) and `THROW_CRASH`.
- **Per-instance allocator.** The runtime caches a reference to `$alloc` on instance load. Calling `$alloc` from the worker after wake is a normal export call; no host-thread coordination needed.
- **Walker / builder host context.** The runtime stores the active `WalkerHost` / `BuilderHost` on the per-call instance state. Walker imports check this state and trap (treated as a crash, not a rejection) if called outside `walk_*`.
- **Imported memory option.** Modules built by toolchains that prefer to receive memory (e.g. some Rust profiles) can `(import "env" "memory" ...)` instead of exporting. The runtime supplies a memory of the requested kind; under Atomics it must be shared.

---

## Resolved Design Questions

- **i64 packed pointer return vs out-parameter convention.** Chose packed `i64` over `(out_ptr, out_cap) -> actual_len` because it avoids the size-then-read race window and lets imports allocate via the contract's `$alloc` with a single host call. Packed pointers are also the path of least friction in AssemblyScript (`i64` returns are first-class) and easy to unpack in any source language.
- **Single shared `scaffold.*` namespace vs split (`scaffold_env`, `scaffold_walker`, `scaffold_builder`).** Split chosen so contracts only declare imports they use; the import list also serves as a static capability check ("this contract uses the walker hooks").
- **Reject via import vs return code.** Import (`scaffold_env.reject`) chosen so the reason string survives end-to-end and so the contract's call sites compose naturally — every code path can branch into rejection without rearranging the call stack.
- **Async transport coupling.** Decoupled. The contract sees the same import signatures regardless of whether the runtime uses Atomics or JSPI.
- **Per-contract metadata as block records, not WASM exports.** `output_namespaces`, `abi_version`, `max_memory_pages`, `budget_ms_hint` all live as record outputs on the contract block. Reading them does not require instantiating the WASM. See [Block-level contract metadata](#block-level-contract-metadata).
- **Numeric value range.** All coin amounts are `i128` on the wire. WASM has no native i128, but the spec passes values inside serialised structs everywhere they appear, so no special import signatures are required. The TS adapter marshals to/from `BigInt`.
- **Walker/builder skip asymmetry.** Walkers can skip (`emit_map_start` / `emit_list_start` return `0` to skip the branch); builders cannot. When writing, a contract must produce the entire structure — there is no skip.

---

## Open Questions

- **WASM feature whitelist.** Determinism requires pinning the exact wasm32 feature set contracts may use (NaN canonicalisation, bulk memory, SIMD, threads). Defer concrete spec to a follow-up; in the meantime, "wasm32 MVP + the imports listed here" is the safe target.
- **Reject reason size cap.** Unbounded rejection strings let a malicious contract bloat per-peer logs. Pick a cap (e.g. 4 KiB) before implementation.

---

## Implementation

| File | Description |
|------|-------------|
| Future: `src/core/WasmContractAdapter.ts` | Wraps a `WebAssembly.Instance` as a `Contract`. Marshals `ContractEnv` calls per this ABI. |
| Future: `src/core/WasmExecutor.ts` (or extension to `ExecutionQueueService.ts`) | Worker pool, transport selection (Atomics / JSPI), per-instance lifecycle. |
| Future: `src/worker/WorkerChannel.ts` (extended) | Bidirectional bytes channel with reject/crash distinction. |
| Future: `src/worker/Instance.ts` (extended) | Worker-side import bindings for `scaffold_env`, `scaffold_walker`, `scaffold_builder`. |
| Existing: [`src/core/ContractEnv.ts`](../../src/core/ContractEnv.ts) | The TypeScript interface this ABI mirrors. |
| Existing: [`src/contracts/Contract.ts`](../../src/contracts/Contract.ts) | The `Contract` interface a `WasmContractAdapter` implements. |
| Spec: [`docs/protocol/computation.md`](computation.md) | Semantic surface for `run`, `claimNext`, `request`, etc. |
| Spec: [`docs/protocol/output-data.md`](output-data.md) | Walker/builder semantics and value descriptors. |
