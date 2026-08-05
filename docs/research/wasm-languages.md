# Languages that run in a browser WASM engine (Aug 2026)

Companion to `wasm-languages.json` (64 implementations). The model used throughout:

- **compiler** -- an optional WASM module that takes source `S` and emits the interpreter (or an artifact the interpreter consumes)
- **interpreter** -- a WASM module that takes arguments and optionally `S`, and produces a result

Each entry is scored two ways: how hard it is to re-target its imports/exports at the Scaffold contract ABI (`scaffold_env.*` / `scaffold_walker.*` / `scaffold_builder.*`, exports `alloc` + `run`), and whether it survives `scripts/wasm-determinism`.

---

## 1. The finding that matters most: WasmGC disqualifies the 2024-2026 winners

Every language that got a genuinely good browser story in the last two years did it via **WasmGC** -- Kotlin/Wasm, dart2wasm, Scala.js's Wasm backend, `wasm_of_ocaml`, TeaVM, Guile Hoot. WasmGC has been baseline across Chrome 119 / Firefox 120 / Safari 18.2 since late 2024 and was standardized in Wasm 3.0 in September 2025.

The determinism transformer bans the entire `0xfb` GC opcode family, and separately bans Wasm exception handling (which Scala.js and .NET both require). So the modern managed-language wave is hard-blocked -- not by browsers, by our own rules.

**But the ban is liftable, and for narrower reasons than "GC is nondeterministic."** Checked against the spec: WasmGC has no way to obtain an address, no reference-to-integer conversion, and no byte view of a struct; finalizers, weak references, heap introspection and allocation control are all deferred post-MVP. So GC timing, object layout and address-derived identity hashes -- the classic nondeterminism sources -- are absent by construction. What remains is resource exhaustion: allocation failure (the spec defines no OOM semantics), and engine-specific static limits that diverge at *validation* time (V8: `kV8MaxWasmStructFields = 999`, `kV8MaxWasmArrayInitLength = 999`, `kV8MaxRttSubtypingDepth = 31`, all marked not standardized).

The `memory.grow` abstain guard doesn't transfer, because allocation failure traps rather than returning a value. Lifting the ban means pre-emptive allocation metering against a protocol cost model -- which needs the type section parsed, the same prerequisite as re-enabling integer SIMD. Full analysis and the argument against are now recorded in `scripts/wasm-determinism/README.md`.

Verdict distribution across all 64: **12 ok, 32 needs-rebuild, 11 likely-blocked, 9 blocked** -- reflecting the rules as they stand today, not as they could stand.

## 2. What is actually usable today

Ranked by "could I have this working under the Scaffold ABI in a week vs. a quarter".

| Tier | Implementation | Language | Size | Why |
|---|---|---|---|---|
| **A** | **Lua** (wasmoon sources, rebuilt freestanding) | Lua 5.4 | ~250KB | ~250KB of ANSI C, documented embedding API, built-in bytecode compiler via `load()`/`string.dump()` -- the compiler/interpreter split comes free |
| **A** | **SQLite** (official amalgamation, own VFS) | SQL | ~1MB | Pluggable VFS is designed for exactly this; plain scalar C, no EH/SIMD/GC |
| **A** | **QuickJS-NG** WASI reactor build | JavaScript | 1.45MB | Reactor mode is already "instantiate once, call eval repeatedly"; tiny WASI subset actually used |
| **A** | **Javy** dynamic mode | JavaScript | 1-16KB + 869KB shared | Two-function plugin ABI; structurally identical to what you're describing |
| **A** | **wasmi / wasm3** | WebAssembly | 250-300KB | Metered inner engine; you define float and trap semantics instead of trusting three browser engines to agree |
| **A** | **revm** (EVM) | EVM bytecode | small | Deterministic metered state-transition interpreter -- the closest existing analogue to a Scaffold execution contract |
| **B** | **AssemblyScript** | AS (typed TS subset) | n/a | Compiler already runs in the browser; you declare the import table yourself |
| **B** | **MicroPython** | Python subset | ~303KB | Only realistic Python for per-execution instantiation; check the NLR backend (setjmp/longjmp may lower to Wasm EH) |
| **B** | **Monty** (Pydantic, Feb 2026) | Python subset | small | Purpose-built for our constraints: no FS/net/env, only explicit host calls, hard CPU/memory limits |
| **B** | **TinyGo** | Go subset | ~50KB | `wasm-unknown` target emits near-zero imports; `//export` names exports directly |
| **B** | **Blink** | x86-64 Linux binaries | ~250KB | Pure interpreter, no runtime codegen -- unlike v86/CheerpX it isn't auto-disqualified. A universal runtime in 250KB |
| **C** | Zig (local build), GHC wasm, Swift Embedded, LFortran, SWI-Prolog, AtomVM/Popcorn | | 1-6MB | Real but heavy, or Emscripten-coupled |
| **Blocked** | Kotlin, Dart, Scala.js, wasm_of_ocaml, TeaVM, Hoot | | | WasmGC |
| **Blocked** | .NET, DuckDB, Scala.js | | | Wasm exception handling |
| **Blocked** | v86, CheerpX | | | Generate wasm at runtime |

One sharp edge to check early: the transformer also bans the **reinterpret family** (`i32.reinterpret_f32` etc.). Every language runtime that formats or parses floats does double bit-punning in `dtoa`/`strtod`, and NaN-boxing engines do it constantly. Whether that lowers to `reinterpret` or to a memory store/load is a codegen detail. **Run the transformer against `qjs-wasi.wasm` before committing to QuickJS** -- it's a 10-minute check that could invalidate the top JS candidate.

## 3. The compiler stage: 23 compilers already run as WASM

Of the 64 entries, 23 have a compiler hosted in WASM. The interesting ones:

| Compiler | Runs as wasm | Emits | Notes |
|---|---|---|---|
| **Zig** (`zig-wasm-zig2wasm.wasm`) | yes, WASI p1, 5.8MB | wasm32-freestanding | **Verified locally** -- see §6 |
| **LFortran** | yes | wasm (direct backend, no LLVM) | Compiler-in-wasm emitting wasm; rare combination |
| **AssemblyScript** `asc` | yes | wasm | Compiler is portable code, runs in-browser for hot-swapping |
| **solc** (`soljson`) | yes, Emscripten | EVM bytecode | Every historical version published as a wasm build; what Remix runs |
| **Gleam** | yes | JS/Erlang | Rust compiler, cargo wasm target -- but doesn't close the loop to wasm |
| **MoonBit** | yes | wasm | Wasm-native language, browser IDE; beta, verify governance/licensing |
| **clang** (Wasmer) | yes, WASIX, ~100MB | wasm | Needs `posix_spawn` (driver forks lld); works in Chrome/FF/Safari |
| **Guile Hoot** | yes | WasmGC | Ships its own assembler/linker in Scheme |
| **Motoko** | yes | wasm | Designed for deterministic replicated blockchain execution |
| **esbuild / SWC** | yes | JavaScript | In-browser TS; esbuild's Go-in-wasm build is reportedly slow |

Notably absent: **rustc** (LLVM size + linker spawning + FS-heavy driver; a long-running internals thread, nothing shipping), the **official Go toolchain**, and any small **C++** compiler.

**TCC is the near-miss worth knowing about.** A whole C compiler in ~400KB of wasm with a hand-written 72-function POSIX shim and a fake filesystem -- exactly the shape of a compiler contract. It's blocked only on codegen: TCC has no WebAssembly backend, so it emits native code. Adding one is a real but bounded project.

## 4. Prior art for the two-stage model

Four projects already implement the compiler→interpreter split concretely. Read these before designing one:

1. **Javy dynamic linking** -- `javy build -C dynamic` emits a 1-16KB module holding only QuickJS bytecode, importing two functions (`realloc`, `eval_bytecode`) from a separately-deployed 869KB provider module. Static mode inlines the engine at ≥869KB *per module*. For a protocol where every program is a separately-stored artifact, that ratio is the whole argument.

2. **Wizer** -- the generic mechanism. Instantiate a module, run an init function, snapshot the heap into the data segments of a *new* module. This is "compiler" for any interpreter, without writing a compiler: `interpreter.wasm + S → a content-addressed module with S baked in`. Javy and ComponentizeJS both use it. Reported 1.35-6x faster instantiation.

3. **ruby.wasm + wasi-vfs** -- packs a directory of `.rb` files into a static virtual filesystem linked into the interpreter module, without rebuilding Ruby. Same idea as Wizer, at the file level.

4. **solc-js** -- versioned, content-addressed wasm compilers feeding a separately-specified deterministic interpreter, with bit-for-bit reproducible output per version. Ethereum already solved compiler-version pinning; worth copying rather than rediscovering.

Also relevant to transport rather than compilation: **wa-sqlite** implements a JS-side VFS where every storage call can block, using Asyncify or JSPI -- structurally the same problem `JspiTransport.ts` solves.

## 5. Host bindings: three worlds, not five

The taxonomy that actually predicts porting effort:

- **WASI preview 1** -- a small, stable syscall set. The only one you can realistically reimplement over `scaffold_env`. Most modules use a handful of calls: `fd_write`, `fd_read`, `proc_exit`, `args_get`, plus `clock_time_get`/`random_get` which you want stubbed anyway. Zig, QuickJS-NG, GHC, Swift, ruby.wasm, wasm3, Grain live here.
- **Emscripten** -- the `.wasm` is half the artifact; the generated JS implements the filesystem, the object bridge, and often dynamic linking. Porting means *rebuilding*, not shimming. Pyodide, php-wasm, SWI-Prolog, WebR, DuckDB, PGlite, solc, wasmoon, Binaryen live here. `-sSTANDALONE_WASM` is best-effort and has known cases of not being fully honoured -- verify per project, don't assume.
- **Everything else** -- WASIX (clang, python.wasm: adds threads, sockets, `posix_spawn`; too large to shim), WASI p2 / component model (no native browser implementation; reaches browsers only via `jco transpile` back to core wasm + JS glue), wasm-bindgen (Rust-specific, but Rust makes retargeting a trait impl).

Practical rule: **Emscripten-native projects are the ones where "just rebuild it against our ABI" quietly means "port it".**

## 6. The local Zig build

`/Users/joel/source/zig/` contains a working WASM-hosted Zig compiler. Two artifacts:

- **`zig-wasm-zig2wasm.wasm`** (5.8MB) -- built by `build_wasm_zig2wasm.sh` with `dev=.wasm`, so it uses the self-hosted WASM backend and linker. **It compiles Zig source to `wasm32-freestanding` with no LLVM involved.** The script's step 5 verifies this: it runs the compiler under wasmtime against a test `.zig` file and disassembles the resulting `.wasm`. Imports confirmed as pure `wasi_snapshot_preview1`.
- **`zig-wasi.wasm`** (5.2MB) -- `build_wasm_wasi.sh`, `dev=.bootstrap`, can only emit `-ofmt=c`. Superseded by the above.

The build needs two source patches (`src/dev.zig` adds `.legalize` to the `.wasm` dev environment; `src/main.zig` fixes `self_exe_path` typing on WASI), applied and reverted automatically. Both were built 2026-03-14; the tree is on a recent master, so the patches may need refreshing.

This is a genuine compiler-as-wasm-module, and it's the one that closes the loop (Zig in → wasm out). Its cost is the filesystem: it wants a mounted source tree, the ~40MB Zig std lib, and cache directories, so a WASI-p1 shim over an in-memory VFS is required. That's the gating work, not the compiler itself.

## 7. Size is the hidden constraint

Against `experiments/wasm-limits/results.md` -- a minimal Zig contract is ~170 bytes, and V8 compiled 10,000 unique modules in ~250ms -- the candidates split cleanly:

| Fits a per-execution model | Doesn't |
|---|---|
| Lua ~250KB, Blink ~250KB, wasm3 ~300KB, MicroPython ~303KB, SQLite ~1MB, QuickJS 1.45MB, Javy plugin 869KB | Pyodide ~10MB, PGlite ~3MB (gz), Zig 5.8MB, DuckDB ~35MB, yaegi 38MB, clang ~100MB |

Javy's static-vs-dynamic ratio (869KB inlined per module vs. 1-16KB against a shared plugin) is the clearest argument in the dataset for a shared-interpreter architecture.

## 8. Browser feature baseline

| Feature | Status |
|---|---|
| WasmGC | Chrome 119, Firefox 120, Safari 18.2 -- baseline since late 2024 |
| Wasm 3.0 (GC, EH, tail calls, memory64, SIMD) | W3C standard, Sept 2025 |
| **JSPI** | Unflagged Chrome 137 (May 2025); **flagged in Firefox 131+**; Safari Technology Preview with an implementer assigned (objection withdrawn late 2025). Phase 4 since April 2025 |
| WASI p2 / components | No native browser engine implementation; browsers reach it only through `jco transpile` |

`JspiTransport.ts` is therefore effectively **Chrome-only in production today**. Anything requiring blocking host calls from the guest inherits that constraint, which argues for keeping the sync in-process transport viable for the common path.

---

## Open questions for you

1. **Is the WasmGC ban permanent policy?** It costs six well-supported languages, and the mechanical objections are solvable (see §1 and the determinism README). The real question is whether you're willing to move the allocator out of the bytes you hashed and into V8's collector, where you can't audit or version-pin it. That's a judgment call, not a technical blocker -- but it's now written down either way.
2. **Does QuickJS actually survive the transformer?** The reinterpret ban is the risk. This is a quick empirical check and it determines whether the top JS candidate is real.
3. **Do you want a compiler stage at all in v1?** Wizer plus a shared interpreter gets you most of the benefit (content-addressed program artifacts, cheap per-program storage) without anyone writing a compiler. Javy's dynamic mode is a working existence proof at 1-16KB per program.
4. **Should the first target be Lua or SQLite rather than JS?** Both are dramatically easier to get correct, and SQLite maps onto the "INSERTs compile, SELECTs interpret" framing you already sketched. JS is the one everybody wants and the one with the most determinism hazards.
5. **Is the inner-interpreter option (wasmi/wasm3) on the table?** Nesting an interpreter costs a large constant factor but buys metering, a smaller trusted feature set, and float/trap semantics you define rather than inherit from three browser engines that only mostly agree.
