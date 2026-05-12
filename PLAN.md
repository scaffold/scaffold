# WASI Shim build plan (worktree-scoped)

This plan is the brief shared by every team that builds the WASI shim per
`docs/design/wasi-shim.md`. It is intentionally short. Read the design doc
first; this file just locks ordering and ground rules so parallel teams
don't drift.

## Ground rules

1. **Design doc is the spec.** When implementation reveals a gap, update
   `docs/design/wasi-shim.md` and call it out explicitly in your hand-off.
   Do NOT silently work around the doc.
2. **Peer review every code change.** After writing, spawn a reviewer agent
   focused on elegance + simplicity (not just correctness). Iterate until the
   reviewer signs off, then return both the diff and the reviewer's note.
3. **Stay scoped.** Build the 12-call MVP. Other calls remain ENOTSUP stubs
   in `src/contracts/wasi-shim/src/main.zig` — don't expand the surface.
4. **Test packages: QuickJS only for now.** The doc rules out SpiderMonkey
   (preview2) and SQLite (no maintained preview1). PHP / Ruby / Python come
   after QuickJS shakedown lands and the team has cycles.
5. **Surface, don't hack.** Any blocker, ambiguity, or design smell goes back
   up the chain in plain text. The orchestrator decides; you flag.

## Phase order (also enforced via TaskList dependencies)

| # | Phase | Parallelism | Inputs | Output |
|---|---|---|---|---|
| A | Reference review + recon | 4-way | design doc, WasiImpl.ts | `docs/design/wasi-shim-decisions.md` |
| B | Foundation modules (Zig) | up to 12 | Phase A decisions | foundation `.zig` files |
| C | 12-call WASI ABI | up to 6 | Phase B foundations | abi `.zig` impls |
| D | TS setup + build pipeline | 2 | shim builds | `setup.ts`, deno task hook |
| E | Contract-trace snapshot tests | up to 12 | Phases C+D | `tests/WasiShim.test.ts` + fixtures |
| F | QuickJS e2e | 1 | Phases C+D+E | vendored quickjs.wasm + e2e snapshot |
| G | Doc + commit polish | 1 | everything | clean `git log`, updated doc |

## Per-call MVP table (12 calls)

| Call | Owner module | Notes |
|---|---|---|
| `proc_exit` | `abi/proc.zig` | exit(0) returns from `run`; nonzero → `scaffold_env.reject` |
| `fd_write` | `abi/fd.zig` | iovecs via `program_mem.read_bytes`; route by FD path |
| `fd_read` | `abi/fd.zig` | same shape inverted; backed by `paths.zig` resolvers |
| `fd_close` | `abi/fd.zig` | flush write buffer → `emit_output`; null slot, push free-list |
| `fd_seek` | `abi/fd.zig` | full i64 math, no Number coerce |
| `fd_fdstat_get` | `abi/fd.zig` | 20-byte struct |
| `fd_fdstat_set_flags` | `abi/fd.zig` | only APPEND/DSYNC/NONBLOCK/RSYNC/SYNC reach us |
| `fd_filestat_get` | `abi/fd.zig` | required by stat/fstat |
| `fd_readdir` | `abi/fd.zig` | DIRCOOKIE_START=0; EOF when bytes-written < buf-size |
| `path_open` | `abi/path.zig` | gate by oflags+fdflags; rights bitmap is informational |
| `path_filestat_get` | `abi/path.zig` | parallels fd_filestat_get |
| `clock_time_get` | `abi/clock.zig` | REALTIME = block ts × 10^6; MONOTONIC = call counter |
| `random_get` | `abi/random.zig` | shared stream with `/dev/random` |

(The first three argv/env calls — `args_get`, `args_sizes_get`,
`environ_get`, `environ_sizes_get` — are already in scope via Phase B's
`abi/args_env.zig` because they fall out of `state.zig`.)

## Reviewer focus

When you spawn a reviewer for a code change, brief them with:

> Review the diff for **elegance and simplicity**. The design doc is the
> spec — flag any divergence. Specifically check: (1) deterministic — no
> wall clock, no real entropy; (2) no silent error swallows — every
> rejected input should hit `scaffold_env.reject` or return a typed errno;
> (3) imports/exports match `main.zig`'s declared shape; (4) Zig idioms —
> no manual bit-twiddling where `packed struct` would do, no allocator
> usage outside the bump buffer; (5) one obvious way to do the thing —
> if you see two paths doing the same work, flag it.
> Return either "approve" with a one-line note, or a numbered list of
> change requests.

## Worktree

You are in `.claude/worktrees/wasi-shim-build/`. The original `main` checkout
has the same files (skeleton + doc edit) uncommitted. Land everything here;
the orchestrator will commit and merge at the end.
