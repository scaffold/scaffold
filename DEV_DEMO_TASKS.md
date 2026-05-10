# Dev Demo — Task Breakdown

A homepage-bound interactive demo that shows, per language: **write code → compile via a Scaffold contract → call the resulting contract → see output**. New tab in the existing `demo/` app, alongside Chess.

Languages (initial set): TypeScript, JavaScript, Go, Python, Zig, Rust, C++, C, AssemblyScript, Sqlite.

**Rollout:** AssemblyScript end-to-end first (compiler is browser-native, smallest scope). Other languages added one at a time with the same task shape.

---

## 0. Decisions Locked In

- **Compiler delivery**: case-by-case per language. Large WASMs are acceptable since contracts can run on remote peers (a core Scaffold property). Optimise per language; do not block on size.
- **Compilers are real Scaffold contracts**, not locally-registered JS helpers. Each compiler is a block whose hash is referenced in the UI; the Scaffold network handles fetching the contract and/or routing the compile request to a peer that has it. Works the same locally and remotely.
- **No demo-specific caching layer.** Block-hash determinism + the network's normal block propagation handles cache reuse; we don't add anything bespoke.
- **No genesis changes.** Compiler contract hashes are baked into the UI as constants. Nothing pre-seeded.
- **WASM execution model**: full async via Worker pool sitting behind `ExecutionQueueModule`, bridging `ContractEnv` calls back to the main thread. Default mechanism is `SharedArrayBuffer` + `Atomics.wait` (battle-tested, works in all browsers with COOP/COEP). JSPI (`WebAssembly.Suspending` / `WebAssembly.promising`) is now stage-4 and shipped in Chrome 137+; we'll spec the ABI so a JSPI backend can be swapped in later as a perf/UX win on supporting browsers, but Atomics is the v1 implementation.
- **Hash explorer**: clicking a hash opens the existing `BlockExplorerOverlay` modal (the same one behind the lower-right "Explorer" pill), pre-focused on that block hash.
- **Demo location**: new tab in `demo/`, hash-routed (`#dev-demo`).
- **One example per language for v1.** Inner sub-tabs deferred; data shape designed to extend.

---

## 1. Workstream A — WASM Runtime (Long Pole)

The bridge from `WebAssembly.Instance` to the `Contract` interface. Nothing else can run real compiled code until this exists.

### A1. WASM Contract ABI spec ✅
- [x] [`docs/protocol/wasm-abi.md`](docs/protocol/wasm-abi.md) — concrete binary contract: required/optional exports, packed-pointer return convention, wire format for `Verifier`/`Input`/`Output`/`ValueDescriptor` (coin values are `i128`), three host-import namespaces (`scaffold_env`, `scaffold_walker`, `scaffold_builder`), reject vs crash error model, async-bridge transport (Atomics default, JSPI fast path), stack composition, hand-rolled echo example, explicit determinism section, block-level contract metadata (output_namespaces, abi_version, max_memory_pages, budget_ms_hint as record outputs on the contract block).
- [x] Cross-linked in `AGENTS.md` source/doc map; `computation.md` and `output-data.md` now reference `wasm-abi.md` as authoritative for the binary surface.
- [ ] **Remaining open questions** flagged in the spec: WASM feature whitelist for determinism, reject reason size cap. Both can be resolved alongside A2.
- [ ] **Identifier renames pending** — possible follow-up to flatten `Verifier { contract, params }` and rename ContractEnv methods (`requireInput → nextInput`, `requireOutput → emitOutput`, etc.). Decisions land in their own pass; spec/code update afterwards.

### A2. Worker pool + pluggable transport behind ExecutionQueue ✅
- [x] Ported the runner-pool + work-stealing pattern from `legacy2/WorkerManager.ts` into [`src/core/wasm/WasmWorkerPool.ts`](src/core/wasm/WasmWorkerPool.ts). Per-instance host-side dispatch lives in [`src/core/wasm/transports/AtomicsWorkerTransport.ts`](src/core/wasm/transports/AtomicsWorkerTransport.ts) (collapsed driver + handler against `ContractEnv` instead of legacy DataTree). The legacy `WorkerChannel.ts` was left untouched; a sibling [`WasmWorkerChannel.ts`](src/worker/wasm/WasmWorkerChannel.ts) carries the new byte-returning + reject/crash protocol the WASM ABI needs.
- [x] [`src/core/wasm/WasmTransport.ts`](src/core/wasm/WasmTransport.ts) — single contract-execution boundary. Five entry points (run + walk_params + walk_data + build_params + build_data + close).
- [x] All three transports implemented in v1:
  - **[`AtomicsWorkerTransport`](src/core/wasm/transports/AtomicsWorkerTransport.ts)** — worker pool, SAB-backed contract memory, byte-returning dispatch with reject/crash split via [`WasmWorkerChannel`](src/worker/wasm/WasmWorkerChannel.ts).
  - **[`JspiTransport`](src/core/wasm/transports/JspiTransport.ts)** — `WebAssembly.Suspending` / `WebAssembly.promising`. Feature-gated via `JspiTransport.isSupported()`.
  - **[`InProcessMockTransport`](src/core/wasm/transports/InProcessMockTransport.ts)** — same-thread, sync-only. Throws clearly if a may-block import is awaited (use JSPI/Atomics for async).
- [x] [`src/core/wasm/WasmExecutor.ts`](src/core/wasm/WasmExecutor.ts) — selects a transport at construction (`'auto' | 'atomics' | 'jspi' | 'in-process'`), holds the pool, exposes `run` / `walk*` / `build*` / `close`.
- [x] New WASM worker stack added alongside the legacy one: [`wasmInstance.ts`](src/worker/wasm/wasmInstance.ts) (per-instance host imports closure) and [`wasmWorker.ts`](src/worker/wasm/wasmWorker.ts) (worker entrypoint). Legacy `src/worker/Instance.ts` and `worker.ts` stay — they back the existing JS-contract path.
- [x] Walker / builder paths included end-to-end. Wire codec lives in [`src/core/wasm/WasmWireCodec.ts`](src/core/wasm/WasmWireCodec.ts) (Verifier, Claim, Output, ValueDescriptor, packed-i64, i128).
- [x] COOP/COEP middleware in [`demo/vite.config.ts`](demo/vite.config.ts).
- [x] Tests in [`tests/WasmTransport.test.ts`](tests/WasmTransport.test.ts) parameterised over all three transports (echo, reject, walk_params, build_params). Codec round-trips in [`tests/WasmWireCodec.test.ts`](tests/WasmWireCodec.test.ts). Hand-rolled fixtures under [`tests/fixtures/wasm/`](tests/fixtures/wasm/) (`.wat` committed for documentation; `.wasm` compiled by `build.sh` via `wat2wasm`).

**Deferred to follow-ups** (flagged in plan):
- `i128 → bigint` migration of the TS `Output.value` type (today serialised through `number` with safe-int check).
- Memory caps + budget enforcement — that's A3 (the adapter feeds them through).
- WorkerChannel chunking for results larger than 64 KiB — single-shot only in v1.
- Stack composition (`wasm_hashes`) — A4.
- Forking — A4.

### A3. Contract execution plugins (`ContractPlugin`) ✅
Reshaped from "wire `WasmStore` into `ContractHost`" into a pluggable execution surface:

- [x] [`ContractPlugin`](src/core/ContractPlugin.ts) interface: `{ accepts(block) -> bool; getContract(block) -> Contract }`. Plugins are walked in registration order; first to accept wins.
- [x] [`ContractHost`](src/core/ContractHost.ts) now walks plugins after the TS registry misses, caches results per contract hash. `ContractHostService` wires the `BlockStore` so plugins always see live blocks.
- [x] [`wasmContractPlugin`](src/plugins/wasm/WasmContractPlugin.ts) accepts any block carrying a `wasm` record output. `WasmContractAdapter` lazily compiles the WASM, delegates `run` / `walkParams` / `walkData` / `buildParams` / `buildData` to a shared `WasmExecutor`, and parses `output_namespaces` off the contract block.
- [x] `ScaffoldConfig.contractPlugins?: ContractPlugin[]` defaults to `[wasmContractPlugin()]`; threaded through `NodeContext.contractPlugins` to `ContractHost.registerPlugin`.
- [x] All WASM code lives under `src/plugins/wasm/` (moved from `src/core/wasm/`).
- [x] Tests: `tests/ContractPlugin.test.ts` (plugin walk semantics, caching, invalidation), `tests/WasmContractPlugin.test.ts` (end-to-end echo via plugin + ContractHost).

**Deferred** (was the original "auto-populate WasmStore on canonical record blocks"): the live link from "a `record('wasm', ...)` block landed" to "now callable" already works because `ContractHost.getContract(hash)` resolves through the plugin on demand. No background populator needed -- lookups are lazy.

### A4. Composition: stacking and forking
Both mechanisms are formalised in [`docs/protocol/wasm-abi.md`](docs/protocol/wasm-abi.md#composition).

**Stacking** (static, in-band, low-overhead):
- [ ] In `WasmContractAdapter`: read the contract block's `wasm_hashes` record. For each blob hash (bottom-to-top), `fetch({ contract: HASH_CONTRACT, params: blobHash })` to get the WASM bytes, instantiate, and wire its exports into the next layer's imports. The primary `wasm` (top of the stack) is instantiated last with the layer below as its import object.
- [ ] Provide a single runtime-supplied shared linear memory imported by every layer under `(import "env" "memory")`. Reject contracts whose stack layers export a memory.
- [ ] Restrict `scaffold_env.*` / `scaffold_walker.*` / `scaffold_builder.*` to wasm 1 (bottom). Higher layers must not see the host imports.
- [ ] Reject cycles in the stack at load.
- [ ] One per-verifier budget shared across the entire stack.
- [ ] Ship a stock `wasi-shim.wasm` contract block whose `wasm` record is a thin shim that maps WASI snapshot preview 1 syscalls onto `scaffold_env`. Use `src/worker/WasiImpl.ts` as the reference behaviour. Compile the shim from minimal Zig or hand-write the `.wat`.

**Forking** (dynamic, out-of-band, parallel):
- [ ] Wire `GeneratingEnv.fork(verifier, records)` into the generation pipeline (currently a stub that throws). Implementation needs:
  - Spawn a sub-generator on `verifier` with its own `ContractEnv`, own claims / outputs / namespace, own per-verifier budget.
  - Route the sub-contract's `requestBody(v)` calls through the parent-supplied `records[]` first (verifier-equality match → return `(value, body)` and emit slot on the sub-block); fall through to the normal handler chain on no match.
  - Block the parent generator until the sub-block commits, propagating `ContractRejection` from the sub-generator up.
  - Auto-emergence: if the sub-contract claims no inputs and no UTXO matches `verifier`, self-claim a new output under `verifier` on the sub-block. If a UTXO already matches, consume it (idempotent "store-once" property).
  - Cap recursion depth (default 16) to prevent unbounded fork loops.
- [ ] Decide block-placement policy: merge sub-contract outputs into the parent's block when small, place on a new block when larger. Heuristic; not part of the contract-visible semantics.
- [ ] Tests: fork creates a UTXO when none exists; fork consumes an existing UTXO when one matches; fork-of-failing-sub-generator propagates rejection; depth-cap enforced.

### A5. Tests
- [ ] `tests/WasmContractAdapter.test.ts`: load a tiny hand-rolled `.wat` → `.wasm` (compiled at test setup) that emits one record and verify it round-trips through `runVerifying` / `runGenerating`.
- [ ] `tests/WasmExecutor.test.ts`: pool concurrency, host call bridging (sync `inform` and async `dispatch`), error propagation (`ContractRejection`), exhaustion behaviour.
- [ ] `tests/WasiShim.test.ts`: a WASI module compiled from a 5-line C program runs to completion under the shim.

---

## 2. Workstream B — UI Shell (parallel-safe, doesn't block on A)

The dev-demo tab UI. Can be built against a stubbed compiler (returns hard-coded WASM) so that work proceeds independently of the runtime.

### B1. Routing & shell
- [ ] Extend `Route` union in `demo/src/App.tsx` with `"dev-demo"`. Update `parseHash`, `buildHash`, and the route switch.
- [ ] Add a tab/button to the existing toolbar to navigate to the new tab. Mirror the chess link pattern (`demo/src/App.tsx:131-148`).
- [ ] New file: `demo/src/dev-demo/DevDemoApp.tsx` — top-level component holding language tabs.

### B2. Language tab strip
- [ ] `demo/src/dev-demo/LanguageTabs.tsx`: top-level tabs for the 10 languages. Selected language tracked in state and reflected in URL hash (`#dev-demo?lang=assemblyscript`).
- [ ] (Stretch / phase 2) Inner sub-tabs for "examples" within a language. Out of scope for v1; leave the data shape extensible.

### B3. Per-language panel layout
- [ ] `demo/src/dev-demo/LanguagePanel.tsx`: stacked layout, top-to-bottom:
  1. Read-only Monaco editor showing TS `new Scaffold({...})` snippet.
  2. **Editable** Monaco editor with the language's source.
  3. Read-only Monaco editor showing TS `scaffold.fetch({ contract: <compiler-hash>, params: { files, options }, onClaim })` with a Run button overlaid (top-right corner).
  4. Hash output line (`> 0x…`) — clicking the hash opens the explorer modal at that block (see Workstream D).
  5. Editable Monaco editor showing TS `scaffold.fetch({ contract: <hash from above>, params, onResult })` with a Run button.
  6. Plain-text output panel (`> Hello World`).
- [ ] Steps 3 and 5 should reflect live state — when the compile completes, step 5's `contract:` field auto-populates with the resulting block hash; until then it shows a placeholder.
- [ ] Use sensible default examples per language (B6).

### B4. Monaco extensions
- [ ] Generalise `demo/src/YamlEditorField.tsx` into `demo/src/CodeEditorField.tsx` accepting `language` prop. Keep YAML wiring intact for the existing creation modal.
- [ ] Register language IDs Monaco doesn't ship by default: `zig`, `assemblyscript`, `go` (already shipped), `rust` (already shipped). Use `monaco-editor`'s `languages.register` + `setMonarchTokensProvider` for those without bundled grammars.
- [ ] (Stretch) LSP integration. Out of scope for v1.

### B5. Run buttons & state machine
- [ ] Each "Run" button has states: `idle | compiling | done | error`. Show spinner + disable while running. On error, show stderr inline (compiler stderr from `asc.compileString` is text).
- [ ] Per-tab state lives in component-local React state for v1. No persistence.

### B6. Starter examples
- [ ] One example per language defined as a TS constant: source + expected fetch params + expected output. Co-located in `demo/src/dev-demo/examples/`.
- [ ] AssemblyScript example matches the brief: `run(name) -> "Hello " + name`.

### B7. Fixture mode (unblocks UI work from A)
- [ ] Behind a `?fixture=1` URL flag, the Run button skips network compilation and uses pre-baked WASM fixtures stored in `demo/src/dev-demo/fixtures/` so UI work can proceed before A lands. **Not** a JS-contract shortcut — the WASM still runs through whatever runtime exists at the time (worker pool when ready, a tiny `WebAssembly.instantiate`-and-call shim before that). The fixtures are real `.wasm` files, just hand-built.

---

## 3. Workstream C — Compiler Contracts (per-language)

Each language gets a "compiler contract": a Scaffold contract whose params are `{ files: { path: source }, options }` and whose outputs include `record('wasm', <binary>)` and any metadata (e.g. `record('source_map', ...)`, `record('stderr', ...)`).

### C0. Hand-rolled "echo" WASM contract (smoke test for A)
Before any compiler contract, we need *one* working WASM contract end-to-end to prove the runtime. This becomes the first fixture (B7) and the first integration target.

- [ ] Author a minimal `.wat` source under `tests/fixtures/wasm/echo.wat`: takes `params` bytes, emits one record output `('echo', params)`. Build to `.wasm` at test setup with `wat2wasm` (Deno has bindings, or commit the binary).
- [ ] Test it through `runVerifying` and `runGenerating` (covered in A5 but author the fixture here).
- [ ] Wire into the dev demo as the "phase 0" demo so the UI shell has a real working language tab while real compilers are in flight.

### C1. AssemblyScript: bringing `asc` up as a real Scaffold contract
**Constraint**: `asc` is pure JS (~860 KB) with a Binaryen dependency (~14 MB embedded WASM). To make it a Scaffold contract we need to run JS *inside* a WASM contract. Two paths — pick one:

**Path A — Single bundled WASM via Javy.** [Javy](https://github.com/bytecodealliance/javy) (Bytecode Alliance) compiles a JS file + the QuickJS runtime into one self-contained WASM module. Output is a single `.wasm` artifact roughly = `(bundled asc + binaryen) + QuickJS + WASI shim`. Estimated: ~20-25 MB WASM. One contract hash.
  - Pros: simplest to package; one block, one hash, no contract composition.
  - Cons: monolithic; Binaryen's embedded WASM-inside-the-JS-bundle is awkward (Javy expects pure JS). May need to extract Binaryen's WASM and load it via WASI imports separately.

**Path B — Stack: QuickJS contract + asc-as-record (recommended)**. Ship `QuickJSContract` (a generic JS interpreter compiled to WASM) once, separately. Each JS-based "compiler contract" is a thin parameterless contract that pulls `asc.js` as a record input and runs it under QuickJS. Same QuickJS contract serves AS, TS, JS, and any other JS-implemented compilers.
  - Pros: composable, Scaffold-native, one shared interpreter; lighter per-language overhead.
  - Cons: requires WASM stack composition (A4) and a clean record-input convention.
  - Recommend Path B because it pays off across multiple languages.

Tasks (Path B):
- [ ] **C1a. QuickJS WASM contract.** Either build from source or grab a prebuilt (e.g. `quickjs-emscripten` or the Bytecode Alliance's QuickJS WASM build). Wrap in a Scaffold WASM contract: takes `{ source: string, input: bytes }` as params, runs JS, emits records the JS code requested. JS-side library exposes `scaffold.requireResult(key, bytes)` etc. by trampolining to host imports.
- [ ] **C1b. AssemblyScript compiler contract.** A small WASM module whose `run` reads its params (`{ files, options }`), then calls into the loaded `asc.js` (provided as a record input from a `compiler-source` block) via QuickJS. Outputs `record('wasm', binary)`, `record('stderr', text)`.
- [ ] **C1c. asc.js source block.** Publish `asc.js` (and the `binaryen.js` it depends on) as a record-bearing block. Its hash becomes the canonical "AssemblyScript v0.28.17 source" reference.
- [ ] Tests: `tests/AssemblyScriptCompilerContract.test.ts` compiles a 3-line AS program through the full stack and asserts `binary` starts with `\0asm`. End-to-end: ~5-30 seconds depending on cold/warm QuickJS.
- [ ] Use `--runtime stub --optimize --disable bulk-memory,simd` for output WASM (per the AS brief — smallest, most deterministic).

### C2. Sqlite (SECOND — high impact, sqlite-wasm exists)
- [ ] `src/contracts/SqliteContract.ts`: params are SQL DDL+inserts (a string or array of statements). Output: `record('db', <serialized .sqlite bytes>)`. Wraps `@sqlite.org/sqlite-wasm`.
- [ ] Companion `SqliteQueryContract.ts`: params are `{ db: <output of above>, query: SELECT ... }`. Output: `record('result', <rows as JSON or msgpack>)`.
- [ ] Tests.

### C3. Other languages (per-language sub-tasks, in priority order)
For each: pick implementation, scope size, write the contract, write tests, add example.

| Lang | Recommended path | Rough size | Notes |
|---|---|---|---|
| **AssemblyScript** | `asc` as JS contract | ~15 MB toolchain | Done in C1. |
| **TypeScript** | `esbuild-wasm` or `swc-wasm` to JS, then run via QuickJS contract | ~3 MB esbuild + ~1 MB QuickJS | TS path is essentially "JS path with a transpile prepended". |
| **JavaScript** | QuickJS-as-WASM contract; user JS stored as a separate record, executed by interpreter | ~1 MB | Need to ship QuickJS binary. Existing QuickJS wasm builds available. |
| **Sqlite** | `@sqlite.org/sqlite-wasm` | ~1.5 MB | Done in C2. |
| **Zig** | Joel has `zig` compiler compiled to WASM at `/Users/joel/source/zig/`. Wrap it in a WASI-shim contract stack. | Multi-MB | Verify it still builds; package its filesystem expectations. |
| **C** | TCC compiled to WASM, OR `wasi-sdk` clang. TCC is small (~200 KB), `wasi-sdk` is huge (~50 MB). Start with TCC. | 200 KB–50 MB | |
| **C++** | `wasi-sdk` clang | ~50 MB | Same toolchain as C. May share a contract. |
| **Rust** | `rustc_codegen_cranelift` is the only browser-runnable Rust path I'm aware of; full `rustc` won't work. Investigate or stretch-goal. | TBD | **Likely defer** — investigate first. |
| **Go** | TinyGo compiled to WASM (compiler itself). Full `go` is too large. | Multi-MB | Defer until tinygo-as-wasm is verified. |
| **Python** | MicroPython-as-WASM as the interpreter contract, user `.py` stored as record. | ~300 KB | Similar pattern to JS/QuickJS. |

For each language:
- [ ] Investigate compiler/interpreter availability as a WASM target (spike, ~1 day each).
- [ ] Write the compiler contract under `src/contracts/<Lang>CompilerContract.ts` (or interpreter contract).
- [ ] Author the starter example.
- [ ] Tests.
- [ ] Wire into the language tab.

### C4. Compiler contract conventions
- [ ] Document the convention in `docs/protocol/compiler-contracts.md`:
  - Params shape: `{ files: { [path: string]: string }, options: object }`.
  - Outputs: always `record('wasm', binary)`. Optional `record('stderr', text)`, `record('source_map', json)`, `record('metadata', object)`.
  - Error: `ContractRejection` with stderr as the reason.
- [ ] Add the doc to the source/doc map in `AGENTS.md`.

---

## 4. Workstream D — Explorer Integration

### D1. Pre-focused block hash on overlay open
- [ ] Add `initialFocusedHash?: string` to `BlockExplorerOverlayProps` in `explorer/src/components/BlockExplorerOverlay.tsx` (line 43).
- [ ] Thread it to `BlockGraph` (line 323) → `BlockGraph` accepts `initialFocusedHash?: string` (line 648).
- [ ] In `BlockGraph` (line 657), seed `useState<string | null>(() => initialFocusedHash ?? null)`.
- [ ] When the prop changes (e.g. user clicks a different hash while the modal is open), update `focusedHash`. Use a `useEffect`.
- [ ] Force `mode` to `"panel"` (or keep current if already `panel`/`fullscreen`) when an `initialFocusedHash` is supplied.

### D2. Clickable hashes in the dev demo
- [ ] In `LanguagePanel.tsx`, render hashes as `<button>` elements (or upgrade the existing `HashSpan` in `explorer/src/components/HashSpan.tsx` to support an `onClick`).
- [ ] On click, call a callback supplied by `DevDemoApp` that sets `focusedHashFromDevDemo` state.
- [ ] `DevDemoApp` renders `BlockExplorerOverlay` (mirroring the chess and explorer routes) with `initialFocusedHash={focusedHashFromDevDemo}`.

### D3. Decide hash-routing for shareable links
- [ ] Update URL hash on click: `#dev-demo?lang=…&block=0xabc…`. Parse on mount so links are shareable.

---

## 5. Workstream E — Polish & Glue

- [ ] Loading states for WASM compiler downloads (Binaryen is 14 MB — first compile will hang otherwise).
- [ ] IndexedDB caching of compiler binaries so repeat visits are instant.
- [ ] Service worker for offline / fast subsequent loads (stretch).
- [ ] Error surfaces: compiler stderr inline; runtime errors below the output panel; explorer link to the failed block if any.
- [ ] Telemetry / event log instrumentation following AGENTS.md's logging guide: a `dev-demo` system logger via `ctx.logger('dev-demo')`.

---

## 6. Suggested Build Order (Critical Path)

With the "real block contracts only" decision, Workstream A is on the critical path — there is no shortcut to a shippable demo without it. The pieces below are ordered to maximise parallelism and let each milestone produce something user-visible.

**Milestone 1 — Echo demo (proves the runtime)**
1. **A1** — WASM ABI spec.
2. **A2 + A3 + A5** — Worker pool + WasmStore wiring + tests. Atomics-only transport for now.
3. **C0** — hand-rolled echo `.wasm` contract.
4. **B1–B3, B5, B7** — UI shell with the echo contract as the only "language tab". One usable demo end-to-end. Run button compiles nothing; it just calls the echo contract with the textarea bytes.
5. **D1–D3** — clickable hashes opening the explorer modal. Self-contained, can land any time after B1.

**Milestone 2 — AssemblyScript end-to-end (proves the language story)**
6. **A4** — WASM stack composition (required for QuickJS-as-interpreter pattern).
7. **C1a** — QuickJS WASM contract.
8. **C1c** — publish `asc.js` source block.
9. **C1b** — AssemblyScript compiler contract on top of QuickJS.
10. **B6** — AS starter example.

**Milestone 3 — Breadth (more languages, more polish)**
11. **C2** — Sqlite (independent of QuickJS, can run parallel to M2).
12. **C3** — remaining languages in priority order from the matrix in §3.
13. **B4** — register Monaco grammars for each language as it lands.
14. **A2 / JSPI backend** — opportunistic JSPI fast path on Chrome.
15. **E** — polish, IndexedDB caching, telemetry.

---

## 7. Open Questions (revised)

Resolved from the previous round: full block contracts (no JS-helper shortcut), no caching layer, no genesis changes, network handles local+remote, Atomics-by-default with JSPI as a future fast path, one example per language. New questions raised by those decisions:

- **Path A vs Path B for `asc`**: §C1 leans Path B (QuickJS WASM contract + `asc.js` as a record). Path A (Javy bundle into one WASM) is simpler to package. Path B amortises the QuickJS work across JS, TS, AS, and Python. Confirm Path B?
- **Where does QuickJS itself come from?** Build from source (more control, longer setup) or use the Bytecode Alliance prebuilt? Either way it becomes a publicly-referenced contract hash. Any preference for build provenance / signing?
- **`compiler-source` block authorship**: The `asc.js` source block (C1c) needs to be created and its hash known by the dev-demo UI. Who/what creates it? A one-time `scripts/publish-compiler.ts` that I write, or do we want a dedicated "publish" UI? For v1 I'd suggest a script — the hash gets pinned in a constants file.
- **WASI shim shape**: §A4 currently suggests two options — re-use `src/worker/WasiImpl.ts` JS-side via direct host imports, or compile a `.wasm` shim. The first is fast to land; the second is more in-spirit ("WASI is a contract too"). Pick one for v1?
- **Memory limits & timeouts per WASM contract**: Should the executor enforce per-call memory caps and a CPU budget? `ContractVerificationModule` already has `budgetMs`. Do we want a hard kill on runaway WASM, and what's the policy?
- **COOP/COEP impact on the demo site**: Setting cross-origin-isolation headers means third-party iframes/widgets on the same page won't work. Any concern about that affecting the eventual homepage embed?
