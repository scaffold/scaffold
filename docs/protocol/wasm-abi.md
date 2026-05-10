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
| `wasm`              | raw `.wasm` bytes        | The contract module. Required. |
| `output_namespaces` | concatenated 32-byte hashes (no length prefix; total length is the count × 32) | The closed set of contract hashes this contract may produce. Empty record (zero bytes) = produces no outputs. See [computation.md#output-namespaces](computation.md#output-namespaces). |
| `abi_version`       | UTF-8 date string `YYYYMMDD` (e.g. `"20250510"`) | The ABI revision this WASM was built against. Runtimes refuse to load contracts whose `abi_version` is newer than their own supported version, or older than their compatibility floor. (Future: a WASM export `abi_version() -> i32` returning the same date as a packed integer like `20250510`; runtimes verify the two match.) |
| `max_memory_pages`  | little-endian `u32`      | Per-instance memory cap in 64 KiB pages. Defaults to `4096` (256 MiB) when absent. |
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

All coin values (`Output.value`, `Input.value`, the `value` field returned by `get_output`) are `i128`. WASM has no native i128 type; values cross the boundary as 16 bytes inside a serialised struct (the convention everywhere in this spec) — no i128-aware import signatures needed. The TS-side adapter marshals to and from `BigInt`.

### `Verifier`

```
Verifier {
    contract: hash      // 32 bytes
    params:   bytes     // u32 len + bytes
}
```
Total wire size: `36 + params.len`.

### `Input`

The shape a contract sees from `require_input` / `collect_inputs`. Data-less outputs (`Output.data` omitted in the protocol) are filtered out by the runtime before they reach the contract — see [computation.md#data-less-outputs](computation.md#data-less-outputs) — so `Input.data` is always present here.

```
Input {
    verifier:    Verifier   // 36+ bytes
    value:       i128       // 16 bytes
    data:        bytes      // u32 len + bytes
    is_self_claim: u8       // 0 or 1
}
```

For `collect_inputs`, the wire format is `u32 count` followed by `count` consecutive `Input` records.

### `Output` (input to `require_output`)

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
| `params`            | `() -> i64` | packed `(ptr, len)` of `verifier.params` bytes | Synchronous. |
| `timestamp`         | `() -> i64` | block timestamp, ms since epoch | Synchronous. |
| `require_input`     | `() -> i64` | packed `(ptr, len)` of one `Input` wire record | **may block** in generation; throws via `reject` if no matching input in verification. |
| `collect_inputs`    | `(limit: i32) -> i64` | packed `(ptr, len)` of `u32 count + count × Input` | **may block** in generation. `limit = -1` for unbounded. |
| `require_output`    | `(out_ptr: i32, out_len: i32) -> ()` | — | Argument is an `Output` wire record. Synchronous from contract's POV; verification mode validates against the namespace sequence. |
| `get_output`        | `(verifier_ptr: i32, verifier_len: i32) -> i64` | packed `(ptr, len)` of `i128 value + bytes data` | **may block** in generation. The returned bytes are the host's resolved `(value, data)` pair. Contracts must not depend on `value` being final: the block-creation layer may raise it during solidification (see [computation.md#output-requirements](computation.md#output-requirements) "solidification-time value override"). This is a known temporary mechanism; future revisions will fold value resolution into the contract path. |
| `require_result`    | `(key_ptr: i32, key_len: i32, value_ptr: i32, value_len: i32) -> ()` | — | Sets/checks a `RECORD_CONTRACT` self-claimed output. Synchronous. |
| `fetch`             | `(verifier_ptr: i32, verifier_len: i32, key_ptr: i32, key_len: i32) -> i64` | packed `(ptr, len)` of the record value bytes | **may block**. Throws via `reject` if no ancestor block claims the verifier. |
| `get_contract_metadata` | `(verifier_ptr: i32, verifier_len: i32) -> i64` | packed `(ptr, len)` of `i128 value + bytes body` | Read-only lookup against the **contract's own block** (the block whose hash equals the running contract's hash). Used for retrieving record outputs and other metadata baked into the contract definition: `output_namespaces`, `abi_version`, source bytes for interpreter-stack contracts, etc. — see [Block-level contract metadata](#block-level-contract-metadata). Determinism holds because contract blocks are content-addressed and immutable. Throws via `reject` if the contract block is not loaded or no matching output exists. |
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
1. Contract calls (e.g.) `scaffold_env.require_input()`. The Worker-side host stub serialises arguments (none in this case), copies them into the staging buffer, sets the signal flag to `WAIT`, posts a message to the main thread, and calls `Atomics.wait` on the signal buffer.
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
const requireInput = new WebAssembly.Suspending(async () => {
  const input = await env.requireInput();
  const bytes = encodeInput(input);                   // serialise to wire format
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

From the contract's side, `require_input` looks identical to the Atomics version — it returns an `i64` with the packed pointer. The runtime stack-switches to await the JS Promise; no Worker, no SAB, no `postMessage`, no COOP/COEP requirement.

JSPI is a fast path opportunity, not a replacement: as of the spec date, it ships in Chrome 137+, is behind a flag in Firefox, and is not available in Safari. The runtime picks Atomics by default and uses JSPI only when feature detection succeeds and the deployment opts in.

### Constraints common to both transports

- **Re-entrancy from imports back into exports is allowed.** The runtime calls `$alloc` from inside an import handler. Contracts must not assume that a single import call observes a quiescent module state.
- **Import calls are serialised per-instance.** The contract is single-threaded; the runtime never invokes two imports concurrently on the same instance.
- **Per-call CPU/memory budget.** The runtime enforces a per-`run` budget derived from `ContractVerificationModule`'s `budgetMs` (see [computation.md#per-verifier-budget](computation.md#per-verifier-budget)). Exceeding it is a crash. Memory growth past the per-contract maximum is a crash.

---

## Stack Composition

A WASM contract may import other contracts' exports. This is how interpreter-style stacks are built (e.g. a QuickJS contract serving as the runtime for a JS-source contract; a WASI shim providing `wasi_snapshot_preview1` to a WASI-targeting binary).

The ABI itself is unchanged — composition is a *runtime* concern handled by the executor (see [draft-blocks.md](draft-blocks.md) and DEV_DEMO_TASKS §A4). The relevant interaction with this spec:

- A contract that imports from another contract declares those imports under a non-`scaffold_*` namespace, conventionally the imported contract's symbolic name (e.g. `wasi_snapshot_preview1`). The runtime resolves the namespace by instantiating the named contract first and wiring its exports into the importer's import object.
- An imported contract's host imports (`scaffold_env`, `scaffold_walker`, `scaffold_builder`) are bound to the *importing* contract's environment. The imported instance shares no `ContractEnv` of its own; it acts as a pure library.
- The runtime handles ordering: imported instances are constructed before the importer. Cycles are rejected at load.

---

## Examples

### Minimal echo contract (hand-rolled WAT)

A contract that emits one record `('echo', params)` and accepts.

```wat
(module
  (memory (export "memory") 1 1 shared)
  (import "scaffold_env" "params" (func $params (result i64)))
  (import "scaffold_env" "require_result"
    (func $require_result (param i32 i32 i32 i32)))

  ;; bump allocator
  (global $next (mut i32) (i32.const 1024))
  (func $alloc (export "alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $n)))
    (local.get $p))

  ;; "echo" key bytes baked in at offset 0
  (data (i32.const 0) "echo")

  (func (export "run")
    (local $packed i64)
    (local.set $packed (call $params))
    (call $require_result
      (i32.const 0) (i32.const 4)                           ;; key = "echo"
      (i32.wrap_i64 (i64.shr_u (local.get $packed) (i64.const 32)))  ;; value_ptr
      (i32.wrap_i64 (local.get $packed))))                  ;; value_len

  (func (export "output_namespaces") (result i64) (i64.const 0)))
```

Two imports, two exports beyond `memory` and `alloc`. Compiles to a few hundred bytes. The first runtime smoke test (DEV_DEMO_TASKS §C0) targets this exact shape.

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
| Spec: [`docs/protocol/computation.md`](computation.md) | Semantic surface for `run`, `requireInput`, `getOutput`, etc. |
| Spec: [`docs/protocol/output-data.md`](output-data.md) | Walker/builder semantics and value descriptors. |
