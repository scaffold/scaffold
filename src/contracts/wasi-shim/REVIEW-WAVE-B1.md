# Wave B1 Peer Review

## Verdict
- changes-requested (mostly minor; one major around `state.params` slice contract, one minor cluster around silent-fallthroughs in `vfs.FdTable`)

## Findings

### [severity: major] state.zig:42-46 — `InitArgs.params` documented as "bytes hashed into seed", but the type is a borrowed slice with implicit "valid only while alloc bump is undisturbed" lifetime
The `params` field receives the result of `env.params()`, which `scaffold/env.zig` documents as "Slice valid until the next `alloc` call". `state.init` consumes it synchronously inside `computeSeed`, so today it's safe. But the InitArgs API doesn't say that and there's nothing stopping a future caller from saving the InitArgs struct, performing a subsequent `env.contractMetadata(...)` (which the design needs in Wave 2 for `wasi_setup`), and *then* calling `state.init` — at which point `args.params.ptr` references freed bump memory.
**Fix:** either (a) document the lifetime explicitly on `InitArgs.params` ("must outlive this `init` call; not retained after it returns"), or (b) `@memcpy` the params bytes into a fixed [N]u8 buffer in state during `computeSeed` so the seed-derivation doesn't depend on caller-side lifetime discipline. (b) is cleaner; the params can be hashed in chunks if it's longer than a fixed buffer, but typically params is ≤ a few KB.

### [severity: minor] state.zig:18-19 — seed derivation uses `contract_hash || ts_le || params`, design says `H(contract_hash || timestamp_ms_le8 || params)` — match, but the audit flagged this as a design-divergence to surface
The design doc body actually says `H(contract_hash || timestamp_ms_le8 || params)` (per `### /dev/random and /dev/urandom`), so the implementation matches the design. AUDIT.md called this out as an "open question" because the design's table elsewhere mentioned `H(block_hash || contract_hash)`. The implementation picked the right reading; just note in the hand-off that the orchestrator should prune the conflicting old draft text from the design doc so future readers don't re-litigate.
**Fix:** update `docs/design/wasi-shim.md` to remove or strike-through any stray `H(block_hash || contract_hash)` references; keep the `H(contract_hash || timestamp_ms || params)` formulation as the single source of truth.

### [severity: minor] vfs.zig:117-123 — `FdTable.free` silently no-ops on unknown/out-of-range fd
```zig
pub fn free(self: *FdTable, fd: u32) void {
    if (fd >= MAX_FDS) return;
    if (self.entries[fd] == null) return;
    ...
}
```
Per AGENTS.md "Never drop errors silently" — this drops two distinct error conditions (oob fd, double-free) without surfacing them. The vfs is intentionally errno-agnostic so it can't `Errno.BADF`, but it can return `VfsError.BadFd` (already in the error set!) so the abi `fd_close` handler emits the right errno.
**Fix:** change signature to `pub fn free(self: *FdTable, fd: u32) VfsError!void` and return `VfsError.BadFd` on either guard. The abi layer in Wave 2 then maps to `Errno.BADF` cleanly. Cheap to do now while the vtable surface is fresh.

### [severity: minor] vfs.zig:101-107 — `FdTable.get` returns `null` on bad fd; same silent-error concern
Symmetrical to the above. `get` is on the hot path for every `fd_*` call, so returning `?*FdEntry` is fine — the abi layer translates `null → BADF`. The asymmetry (get returns optional, free silently noops) is the smell. If you keep `get` returning `?`, switch `free` to also signal failure via a return; otherwise both should return `VfsError!`.
**Fix:** decide on one convention and apply it to both. My recommendation: keep `get` as `?*FdEntry` (zero-cost lookup) but make `free` return `VfsError!void` (mutation should never silently fail).

### [severity: minor] proc.zig:17-24 — control-flow ambiguity from missing `else`
```zig
if (rval == 0) {
    env.reject(EXIT_ZERO_REASON);
}
var buf: [40]u8 = undefined;
const msg = std.fmt.bufPrint(&buf, ...);
env.reject(msg);
```
Functionally correct because `env.reject` is `noreturn`, but the reader has to know that to see why this isn't a fall-through bug. With an explicit `else` the intent is unmistakable and survives a future refactor that turns `reject` into a regular function.
**Fix:**
```zig
if (rval == 0) env.reject(EXIT_ZERO_REASON);
var buf: [40]u8 = undefined;
const msg = std.fmt.bufPrint(&buf, "WASI proc_exit: {d}", .{rval}) catch unreachable;
env.reject(msg);
```
Or restructure as `if (rval == 0) ... else { ... }`. Either is fine; the current form is the worst of both.

### [severity: minor] proc.zig:26 — `proc_raise` returns `i32` but is unconditionally `noreturn` in body
The body always reaches `env.reject(msg)` which is `noreturn`. Zig accepts the i32 declared return because noreturn is assignable to any type, but this is a documentation lie: the function never returns. The wrapper in `main.zig` exports it as `i32` because WASI's `proc_raise` ABI is `(sig: i32) -> errno`, but the *internal* helper can be `noreturn`.
**Fix:** mark `pub fn proc_raise(sig: i32) noreturn` and let the `main.zig` exporter handle the return-type adaptation (e.g. `export fn proc_raise(sig: i32) i32 { proc.proc_raise(sig); }` — Zig will accept a noreturn call as the body of an i32 export, but the audit/reader should see `noreturn` on the helper).

### [severity: minor] env.zig:27-32 — `contractHash` does an unchecked `slice[0..32]` slice
```zig
pub fn contractHash() [32]u8 {
    const slice = unpack(main.contract_hash());
    var out: [32]u8 = undefined;
    @memcpy(&out, slice[0..32]);
    return out;
}
```
If the host ever returns a slice of length < 32, the `slice[0..32]` slice expression traps in safe build modes (good) but in `ReleaseSmall` (the actual ship mode per design) it does an unchecked read. Per design's "Memory/pointer errors trap, don't errno" it's acceptable for the host import to trap, but the contract is "host returns the canonical 32 bytes" — worth a one-line `std.debug.assert(slice.len == 32)` at the top so the assertion survives in safe-debug test builds and self-documents.
**Fix:** add `std.debug.assert(slice.len == 32);` before the `@memcpy`. Free at runtime cost in Release.

### [severity: minor] env.zig:60-65 — `emitOutput`, `reject`, etc. use `@intCast(@intFromPtr(bytes.ptr))` to land in the i32-typed extern; this only works while shim memory stays under 2 GiB
On wasm32, `usize` is `u32` and pointers can occupy the full [0, 2³²) range; `@intCast(u32 → i32)` traps on any value above 2³¹-1. The shim's bump arena starts at 1 MiB, so today this is fine, but a program that writes large outputs into staging could in principle push the arena past the boundary. The host externs themselves take `i32` for compatibility with the WASM ABI (where i32 is the canonical 32-bit value, sign-agnostic).
**Fix:** use `@bitCast` instead of `@intCast` for the ptr-to-i32 conversion. Same wire bytes, no trap. Apply consistently in `env.zig`, `prog_mem.zig`, `proc.zig` (via `env.reject(msg)` — already routed through `env`), and `main.zig:panic`.

### [severity: minor] prog_mem.zig:50-58 — `readIovecs` does N×2 small `read_bytes` JS hops where one bulk hop would do
Each iovec is 8 bytes (u32 ptr, u32 len). `readIovecs` loops `out.len` times, each iteration making two `read_bytes` calls (4 bytes each) → 2N JS↔WASM crossings for an N-iovec table. For wasi-libc which always passes 1 iovec, this is 2 hops for a measure-once thing; for a `writev` with K iovecs it's 2K. A single `readSlice(src, &raw_buf[0..N*8])` followed by an in-shim decode would be one hop.
**Fix:** rewrite as one `readSlice` into a stack `[256]u8` (or caller-provided buffer) plus an in-shim `std.mem.readInt` loop. Same code volume, ~half the JS hops at the printf-level. Not a blocker but the design explicitly calls out "amortise the cross-memory hop" so this is the right place to do it.

### [severity: nit] types.zig:204-212 — `comptime` block hidden inside the file body; reads as runtime
```zig
comptime {
    const std = @import("std");
    std.debug.assert(...);
}
```
The local `const std = @import("std");` inside a `comptime` block works, but the file already uses `std` at the top (or doesn't — `types.zig` has no top-level `const std = @import("std")`). Either way, hoisting the import to the file top reads more naturally and matches the rest of the codebase (`prng.zig`, `state.zig`).
**Fix:** add `const std = @import("std");` at the top of `types.zig` and drop it from inside the `comptime` block.

### [severity: nit] types.zig:216-219 — `errnoFromVfs` is a stub that always returns `NOTSUP`, which is itself a silent-fallthrough lookalike
```zig
pub fn errnoFromVfs(err: anytype) Errno {
    _ = err;
    return Errno.NOTSUP;
}
```
This is intentional (the real mapping lands with vfs/vfs.zig in batch 2), but it doesn't match the audit's API which named the function but didn't define a stub body. The current stub silently throws away every distinct vfs error (NotFound, NotADirectory, etc.) — easy to forget to come back and fill in. AGENTS.md "never drop errors silently" applies even to placeholders; if a Wave-2 caller wires this up before someone finishes the mapping, every error becomes ENOTSUP and we ship a regression.
**Fix:** either delete the stub (it'll be added with vfs/vfs.zig anyway) or `@panic("errnoFromVfs not implemented")` so accidental Wave-2 use trips loudly. The design's "never drop errors silently" applies even to placeholders.

### [severity: nit] json.zig:42-47 — bespoke `Allocator` interface to avoid `std.mem.Allocator`
The comment on the `Allocator` struct claims `std.mem.Allocator` "pulls in extra `std.mem` machinery we don't want in a freestanding wasm shim", but `prng.zig` and `state.zig` both already `@import("std")` for `std.crypto.hash.sha2.Sha256` (which is way more code than `std.mem.Allocator`). The custom `Allocator` adds 50 lines of test boilerplate (`TestArena.allocFn` etc.) that wouldn't be needed with `std.mem.Allocator`'s standard `vtable` shape.
**Fix:** consider switching to `std.mem.Allocator` and a `std.heap.FixedBufferAllocator` view of the bump arena — same wire result, ~50 fewer lines of test surface, and one obvious way to allocate. (Take or leave: the bespoke interface works and is small. Future-maintainer note.)

### [severity: nit] vfs.zig:79-80 — `MAX_FDS = 256` is a hardcoded constant in a file that has no other tunables
The audit allowed up to 256; the design didn't pin a number. Worth either (a) lifting `MAX_FDS` into a top-level config in `state.zig` or `main.zig` so the limit is co-located with the rest of the per-run sizing knobs, or (b) commenting *why* 256 (e.g. "wasi-libc opens at most ~64 fds for typical programs; 256 covers Python's stdlib walking comfortably without bloating BSS"). Currently it's an unmotivated 256.
**Fix:** add a one-line rationale comment, or move to state.zig as `pub const MAX_FDS: u32 = 256;` next to the other limits.

### [severity: nit] main.zig:79 — `~@as(u32, 15)` works but `~@as(u32, 0xF)` reads more like an alignment mask
```zig
const aligned = (bump_ptr + 15) & ~@as(u32, 15);
```
Pure stylistic — `15` and `0xF` are the same value, but `0xF` immediately telegraphs "low-4-bits mask" while `15` reads as "I added 15". Take or leave.

### [severity: nit] main.zig:280-287 — `panic` handler never adds a prefix; rejection reason is bare panic message
A trap inside the shim today surfaces to scaffold as e.g. `"index out of bounds"` — no signal that the source was the WASI shim vs the program. A prefix like `"WASI shim panic: "` would make production debugging easier (matches the `"WASI proc_exit: ..."` and `"WASI proc_raise: ..."` patterns in `proc.zig`).
**Fix:** in the panic handler, build `"WASI shim panic: <msg>"` into a small fixed buffer and reject with that.

## Cross-cutting observations (no action requested)

1. **No determinism leaks.** No `Date.now`, no `performance.now`, no `crypto.getRandomValues`, no system time, no real entropy reads. The PRNG is purely SHA-256 over `(seed, counter)`. The seed is purely `H(contract_hash || timestamp_ms || params)`. Clean.
2. **No silent error swallows in hot paths.** Every `try` propagates; every `catch unreachable` is on a `bufPrint` whose buffer is provably large enough. The two minor concerns above (vfs.FdTable, types.errnoFromVfs stub) are the only places where errors disappear without trace.
3. **API matches `main.zig`'s declared shape.** The 9 `scaffold_env` externs in main.zig (`mode`, `timestamp`, `params`, `contract_hash`, `contract_metadata`, `emit_output`, `request_body`, `fetch`, `reject`) all line up with `WasmHostBridge.ts`'s flat-export surface, and the `i64` packing matches `WasmWireCodec.packPtrLen` exactly (`(ptr << 32) | len`).
4. **One obvious way.** The cross-memory accessors are routed through `prog_mem.zig` consistently; the scaffold-env externs are wrapped through `env.zig` consistently. No call site reaches around either layer. Good.
5. **comptime asserts on wire layouts.** `types.zig` has the right asserts for `Iovec=8`, `Ciovec=8`, `Fdstat=24`, `Filestat=64`, `Fdflags=2`, `Oflags=2`. Those are exactly the layouts the abi handlers need to match WASI's wasm32 ABI.
6. **JSON parser is well-scoped.** Two-pass count-then-fill is the right call for a bump allocator; depth limit prevents stack blow-up; explicit number rejection and surrogate rejection are good. Tests cover the important shapes.
