# WASI Shim Snapshot-Test Fixtures — Plan

> Status: spec for Phase E. One tiny WAT program per WASI call we want to
> snapshot-test. Each program's _only_ job is to make a WASI host call (or
> two) and trap/exit so the contract-trace snapshot (`tests/helpers/contractSnapshot.ts`)
> captures exactly the shim's downstream behaviour.

## Conventions shared across all fixtures

- Built via `tests/fixtures/wasm/build.sh` (extend the loop to recurse into
  `wasi/` or just glob `wasi/*.wat`). Output: `wasi/<name>.wasm`, sibling
  `.wasm` files committed.
- Every fixture is the **`program`** layer in a two-layer modules graph.
  The other layer is the WASI shim itself (`wasi-shim.wasm`, blob hash baked
  in `setup.ts`). Snapshot tests load the shim from
  `src/contracts/wasi-shim/dist/wasi-shim.wasm`.
- Contract-block records map per test:
  ```jsonc
  {
    modules: { /* base + wasi_shim + program graph */ },
    wasi_setup: { argv: [...], env: {...}, /* per-test */ }
  }
  ```
- Every fixture exports `(memory (export "memory") 1)` because the shim reads
  from / writes to it via `program_mem.read_bytes` / `program_mem.write_bytes`.
  None of these fixtures need `shared` memory (single-threaded execution).
- Every fixture exports `_start` (command-style). The modules graph wires
  `program._start` to the `program` import on the shim layer.
- Imports are all from `wasi_snapshot_preview1.*`. Signatures below match
  the [WASI snapshot preview 1 spec](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md).
- Sequence sketches assume `mock` provides the deterministic-by-design env
  values: `mode = ExecutionMode.Verification`, `contractHash = <some Hash>`,
  `params = <per test>`, `timestamp = <per test>`. The
  per-WASI-call test shape is:
  > `program._start` is invoked → program calls one WASI function → the
  > shim translates that into 0..N `scaffold_env.*` host calls and a
  > terminator (`exit_ok` for `proc_exit(0)` or `reject` for `proc_exit(n)`).
  The `sequence` array captures the host-call side only. The shim's internal
  `program_mem.read_bytes` / `program_mem.write_bytes` JS-forwarder hops
  show up in the snapshot as `forward …` lines via the `tracer` parameter
  on `loadModules`, and don't need to be expressed in `sequence`.

---

### `wasi_proc_exit_ok.wat`
**Purpose**: exercise the shim's `proc_exit(0)` path — clean termination,
no rejection surfaces.

**Behaviour**: `_start` immediately calls `proc_exit(0)`.

**Imports**:
- `wasi_snapshot_preview1.proc_exit` — Zig: `extern fn proc_exit(rval: u32) noreturn;`

**Exports**:
- `(memory (export "memory") 1)`
- `(func (export "_start") ...)`

**Sequence under test**:
```ts
sequence: []   // proc_exit(0) terminates without any scaffold_env call
```
Trace tail: `< exit ok`. (The shim swallows the `__SCAFFOLD_WASI_EXIT_ZERO__`
rejection internally.)

---

### `wasi_proc_exit_fail.wat`
**Purpose**: exercise `proc_exit(n)` for n != 0 — surfaces as a `ContractRejection`
with reason `"WASI proc_exit: 7"`.

**Behaviour**: `_start` immediately calls `proc_exit(7)`.

**Imports**:
- `wasi_snapshot_preview1.proc_exit`

**Exports**: same shape as above.

**Sequence under test**:
```ts
sequence: [
  { type: 'reject', expect: { reason: 'WASI proc_exit: 7' } },
]
```

---

### `wasi_fd_write_stdout.wat`
**Purpose**: exercise `fd_write` against fd 1 (stdout, default-routed to
`/out/debug` per `wasi_setup` defaults). `/out/debug` is a logger sink — no
scaffold output emitted.

**Behaviour**: build a single iovec `(buf=hello_ptr, len=5)`, call
`fd_write(fd=1, iovs=&iovec, iovs_len=1, &nwritten)`, then `proc_exit(0)`.

**Imports**:
- `wasi_snapshot_preview1.fd_write` — Zig: `extern fn fd_write(fd: u32, iovs: [*]const Ciovec, iovs_len: usize, nwritten: *usize) u16;`
- `wasi_snapshot_preview1.proc_exit`

**Exports**: standard.

**Data section**:
- `"hello"` at offset 0
- iovec `(0u32, 5u32)` constructed at offset 16

**Sequence under test**:
```ts
sequence: []   // /out/debug doesn't call scaffold_env at all
```
Trace tail: `< exit ok`. The shim absorbs the bytes into the logger; the
snapshot captures the cross-memory `program_mem.read_bytes` hops the shim
performs to fetch the iovec table and the buffer.

> **Note**: this fixture is the cross-memory smoke test — if the shim
> mis-reads the iovec layout, the test fails before reaching `proc_exit`.

---

### `wasi_fd_write_record.wat`
**Purpose**: exercise `fd_write` against an FD whose path is `/out/record/foo`.
Closing the FD must produce exactly one `emit_output` against the
`RECORD_CONTRACT` with key `"foo"` and body `"hello"`.

**Behaviour**:
1. `path_open(dirfd=preopen("/out"), oflags=O_CREAT, path="record/foo", ...)` →
   FD `n`. (The `wasi_setup.preopens` includes `/out` as fd 3.)
2. `fd_write(fd=n, iovec("hello", 5))`.
3. `fd_close(fd=n)` — this is where the shim emits the output.
4. `proc_exit(0)`.

**Imports**:
- `wasi_snapshot_preview1.path_open` — Zig: `extern fn path_open(fd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fs_flags, opened_fd_ptr) u16;`
- `wasi_snapshot_preview1.fd_write`
- `wasi_snapshot_preview1.fd_close`
- `wasi_snapshot_preview1.proc_exit`

**Exports**: standard.

**`wasi_setup`**: defaults are fine (`preopens: ["/in", "/out", "/scratch", "/dev"]`).
Test must know that `/out` is fd 3 (first preopen after stdio) — bake `3` as
the dirfd constant.

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('foo') },
      value: 0,
      body: utf8('hello'),
    },
  },
]
```
Trace tail: `< exit ok`.

---

### `wasi_fd_read_params.wat`
**Purpose**: exercise `fd_read` against `/in/params`. Verify the program
reads back the bytes provided by `mock.params`.

**Behaviour**:
1. `path_open(dirfd=preopen("/in"), path="params", oflags=0, ...)` → FD `n`.
2. `fd_read(fd=n, iovec(buf, 32), &nread)` — reads up to 32 bytes.
3. Build a single iovec for `(buf, nread)` and `fd_write(fd=1=stdout)` — but
   stdout goes to `/out/debug`, so to make the bytes _observable_ in the
   sequence, instead `path_open(/out, "record/echo")` and write there.
4. `fd_close(write_fd)` → triggers `emit_output`.
5. `proc_exit(0)`.

**Imports**: `path_open`, `fd_read`, `fd_write`, `fd_close`, `proc_exit`.

**Exports**: standard.

**`wasi_setup`**: defaults; `/in` = fd 4, `/out` = fd 3 (or whatever order
the design's defaults give — Phase E coder must check).

**Mock**:
```ts
mock: { params: utf8('hello-from-params'), ... }
```

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('echo') },
      value: 0,
      body: utf8('hello-from-params'),
    },
  },
]
```

> **Note**: `/in/params` is served from `mock.params`, _not_ from a
> `request_body` host call (params are baked into the contract verifier
> itself, so the shim can answer directly without bouncing through scaffold).
> Confirm with the `paths.zig` mapping during Phase E. If implementation
> _does_ bounce through `request_body`, add a `request_body` step before
> the `emit_output`.

---

### `wasi_clock_realtime.wat`
**Purpose**: exercise `clock_time_get(REALTIME)` — must return `timestamp ×
10^6` ns.

**Behaviour**:
1. `clock_time_get(clock_id=0 /* REALTIME */, precision=0, &ns_out)`.
2. Treat `ns_out` (8 bytes LE u64) as the body of an output: write to
   `/out/record/clock` (open + write 8 bytes + close).
3. `proc_exit(0)`.

**Imports**:
- `wasi_snapshot_preview1.clock_time_get` — Zig: `extern fn clock_time_get(clock_id: u32, precision: u64, ts_ptr: *u64) u16;`
- `path_open`, `fd_write`, `fd_close`, `proc_exit`.

**Exports**: standard.

**Mock**: `timestamp: 1234`. Expected ns value = `1234 * 1_000_000 = 1_234_000_000`
= `0x49_949_140` LE = `40 91 94 49 00 00 00 00`.

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('clock') },
      value: 0,
      body: new Uint8Array([0x40, 0x91, 0x94, 0x49, 0, 0, 0, 0]),
    },
  },
]
```

---

### `wasi_clock_monotonic.wat`
**Purpose**: exercise `clock_time_get(MONOTONIC)` — must strictly increase
by 1 ns per call.

**Behaviour**:
1. `clock_time_get(MONOTONIC=1, 0, &t1)`.
2. `clock_time_get(MONOTONIC=1, 0, &t2)`.
3. Write `t1` (8 bytes) || `t2` (8 bytes) = 16 bytes total to
   `/out/record/mono`.
4. `proc_exit(0)`.

**Imports**: `clock_time_get`, `path_open`, `fd_write`, `fd_close`, `proc_exit`.

**Exports**: standard.

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('mono') },
      value: 0,
      // t1 = 1ns (after first call), t2 = 2ns (after second call).
      // (Phase E: confirm whether counter starts at 0 or 1; design says
      // "starts at 0" but advances per call. So t1=1, t2=2.)
      body: new Uint8Array([
        1,0,0,0,0,0,0,0,
        2,0,0,0,0,0,0,0,
      ]),
    },
  },
]
```

> **Note**: monotonic counter semantics — design says "starts at 0,
> advances 1 ns per call". Phase E coder must confirm whether the
> _first_ observation reads 0 or 1 (i.e. is the counter incremented
> before or after the read?). Snapshot will pin the choice; either is
> acceptable as long as the test matches.

---

### `wasi_random.wat`
**Purpose**: exercise `random_get(buf, 8)` — first 8 bytes of the deterministic
PRNG stream.

**Behaviour**:
1. `random_get(&buf, 8)`.
2. Write those 8 bytes to `/out/record/rng`.
3. `proc_exit(0)`.

**Imports**:
- `wasi_snapshot_preview1.random_get` — Zig: `extern fn random_get(buf: [*]u8, buf_len: usize) u16;`
- `path_open`, `fd_write`, `fd_close`, `proc_exit`.

**Exports**: standard.

**Mock**: `contractHash: <fixed Hash>`. The seed = `H(block_hash || contract_hash)`;
the snapshot will pin the first 8 PRNG bytes for the chosen hash. (Phase E:
compute the expected bytes once during `--update`, commit the snapshot. The
fixture itself doesn't bake any expected value — it just emits whatever
`random_get` returned.)

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('rng') },
      value: 0,
      // body intentionally unspecified — snapshot pins it.
    },
  },
]
```

> **Note**: this test depends on the PRNG construction
> `H(seed || counter)` being final. If we change the PRNG construction
> later, this snapshot regenerates. That's fine — it's a determinism
> regression sentinel, not a correctness oracle.

---

### `wasi_args.wat`
**Purpose**: exercise `args_sizes_get` + `args_get`. Verify the shim
returns the configured argv.

**Behaviour**:
1. `args_sizes_get(&argc_ptr, &argv_buf_size_ptr)`.
2. `args_get(argv_ptrs_buf, argv_string_buf)`.
3. Read pointer at `argv_ptrs_buf[0]`, find its NUL terminator (or use the
   first arg's known length), write that string to `/out/record/argv0`.
4. `proc_exit(0)`.

For simplicity, the fixture can hardcode that argv[0] is exactly 7 bytes
(`"asc"` plus the NUL = 4 bytes; pick a fixed-length test value like
`"asc0123"` so the WAT can avoid a strlen loop). The `wasi_setup.argv`
must match.

**Imports**:
- `wasi_snapshot_preview1.args_sizes_get` — Zig: `extern fn args_sizes_get(argc: *usize, argv_buf_size: *usize) u16;`
- `wasi_snapshot_preview1.args_get` — Zig: `extern fn args_get(argv: [*][*:0]u8, argv_buf: [*]u8) u16;`
- `path_open`, `fd_write`, `fd_close`, `proc_exit`.

**Exports**: standard.

**`wasi_setup`**:
```jsonc
{ "argv": ["asc0123"] }
```

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('argv0') },
      value: 0,
      body: utf8('asc0123'),
    },
  },
]
```

---

### `wasi_environ.wat`
**Purpose**: exercise `environ_sizes_get` + `environ_get`. Same shape as
args, but for env vars.

**Behaviour**:
1. `environ_sizes_get(&envc_ptr, &env_buf_size_ptr)`.
2. `environ_get(env_ptrs_buf, env_string_buf)`.
3. Read pointer at `env_ptrs_buf[0]`, write the fixed-length env string
   (e.g. `"FOO=bar"` = 7 bytes) to `/out/record/env0`.
4. `proc_exit(0)`.

**Imports**:
- `wasi_snapshot_preview1.environ_sizes_get` — Zig: `extern fn environ_sizes_get(envc: *usize, env_buf_size: *usize) u16;`
- `wasi_snapshot_preview1.environ_get` — Zig: `extern fn environ_get(env: [*][*:0]u8, env_buf: [*]u8) u16;`
- `path_open`, `fd_write`, `fd_close`, `proc_exit`.

**Exports**: standard.

**`wasi_setup`**:
```jsonc
{ "env": { "FOO": "bar" } }
```
(Encoded as `"FOO=bar"` per WASI convention.)

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('env0') },
      value: 0,
      body: utf8('FOO=bar'),
    },
  },
]
```

---

### `wasi_path_open_then_read.wat`
**Purpose**: exercise the round-trip on `/scratch` — open a file, write a
byte, close, reopen, read it back. Verifies in-memory `memfs` state.

**Behaviour**:
1. `path_open(dirfd=preopen("/scratch"), oflags=O_CREAT, path="foo")` → fd `n1`.
2. `fd_write(n1, iovec(b"X", 1))`.
3. `fd_close(n1)`.
4. `path_open(dirfd=preopen("/scratch"), oflags=0, path="foo")` → fd `n2`.
5. `fd_read(n2, iovec(buf, 1), &nread)` — expect `nread=1`, `buf[0]=='X'`.
6. `fd_close(n2)`.
7. `path_open(/out, "record/scratch_byte")` and write the read byte.
8. `proc_exit(0)`.

**Imports**: `path_open`, `fd_read`, `fd_write`, `fd_close`, `proc_exit`.

**Exports**: standard.

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('scratch_byte') },
      value: 0,
      body: utf8('X'),
    },
  },
]
```

> **Note**: `/scratch` is in-memory only. The shim's memfs handles all of
> this without any `scaffold_env.*` call. So the only sequence entry is
> the final `emit_output` from the `/out/record/scratch_byte` close.

---

### `wasi_fd_readdir.wat`
**Purpose**: exercise `fd_readdir` on `/`. Should iterate `["in", "out",
"scratch", "dev"]`.

**Behaviour**:
1. `path_open(dirfd=preopen("/"), oflags=O_DIRECTORY, path=".")` → fd `n` for
   the root directory. (Or, if `/` is itself a preopen — confirm with the
   `wasi_setup` defaults — use that fd directly.)
2. Loop: `fd_readdir(n, buf, buf_len=512, cookie, &nwritten)`. WASI dirent
   layout: 8 B `d_next` cookie || 8 B `d_ino` || 4 B `d_namlen` || 1 B
   `d_type` || 3 B pad || name bytes (no NUL). Iterate with `cookie =
   DIRCOOKIE_START = 0` initially, then `cookie = entry.d_next` until
   `nwritten < buf_len` (EOF).
3. Concatenate the names with `,` separator into a single buffer.
4. Open `/out/record/dirents`, write the joined string, close.
5. `proc_exit(0)`.

**Imports**:
- `wasi_snapshot_preview1.fd_readdir` — Zig: `extern fn fd_readdir(fd, buf, buf_len, cookie: u64, bufused: *usize) u16;`
- `path_open`, `fd_write`, `fd_close`, `proc_exit`.

**Exports**: standard.

**Sequence under test**:
```ts
sequence: [
  {
    type: 'emit_output',
    expect: {
      verifier: { contract: RECORD_CONTRACT, params: utf8('dirents') },
      value: 0,
      body: utf8('in,out,scratch,dev'),
    },
  },
]
```

> **HARDER THAN EXPECTED — flag for Phase E.**
>
> 1. **`fd_readdir` cookie / iteration loop in WAT is painful**. The dirent
>    layout requires 24 bytes of header parsing per entry plus a variable
>    name field. Open-coding the iteration in raw WAT is ~80 lines of
>    branching arithmetic. Two ways to make this tractable:
>    - **(preferred)** size the buffer at 512 bytes and assume EOF on the
>      single call (root only has 4 entries; total payload is well under
>      512 B). Then we still need to walk the buffer, but the loop is
>      bounded and simple. Loop pseudocode:
>      ```
>      offset = 0
>      while offset < nwritten:
>        d_next  = u64 at offset
>        d_ino   = u64 at offset+8       ; ignored
>        d_namlen = u32 at offset+16
>        d_type   = u8  at offset+20     ; ignored
>        copy nameBytes [offset+24 .. offset+24+d_namlen) → outBuf
>        append b','
>        offset += 24 + d_namlen
>      strip trailing comma
>      ```
>    - **(simpler but less faithful)** just pin the snapshot on the raw
>      `nwritten` bytes from one `fd_readdir` call and emit those verbatim.
>      Loses the join-by-comma readability but the snapshot still pins the
>      shim's behaviour exactly.
> 2. **Whether `/` is preopened by default** — design says preopens default
>    to `["/in", "/out", "/scratch", "/dev"]`, _not_ `/`. To readdir `/`,
>    the program needs `/` in its preopen list. Either bake `"preopens":
>    ["/", "/in", "/out", "/scratch", "/dev"]` into this fixture's
>    `wasi_setup`, or use `path_open` from a preopen dirfd with path `..`
>    (which the design says returns `ENOTCAPABLE`). So the cleanest path
>    is to add `/` to `preopens` for this test only.
> 3. **Stable ordering of dirent names**. The shim's `readdir` for `/`
>    returns the static list `["in", "out", "scratch", "dev"]` in declared
>    order. Phase E should make that order an explicit invariant in
>    `vfs.zig` so this snapshot doesn't flake.

---

## Suggested test file

`tests/WasiShim.test.ts` — one `Deno.test(...)` per fixture, each calling
`assertContractTraceSnapshot(t, { records, blobs, mock, sequence })` with
the `records.modules` graph wiring `wasi_shim` → program. Helper for
graph construction lives in `src/contracts/wasi-shim/setup.ts` (Phase D).

## Snapshot regeneration

```
deno test --allow-all tests/WasiShim.test.ts -- --update
```

After regeneration, hand-review every `__snapshots__/WasiShim.test.ts.snap`
chunk to confirm the host-call order and arguments make sense. The
`forward …` lines in the snapshot are the JS-forwarder hops (cross-memory
copy via `program_mem.read_bytes` / `write_bytes`) — they're load-bearing
correctness signal: a missing one means the shim isn't actually fetching
program-side memory.

## Build pipeline tweak

`tests/fixtures/wasm/build.sh` currently globs `*.wat` in `tests/fixtures/wasm/`.
Extend it to also recurse into `wasi/`:

```bash
for wat in *.wat wasi/*.wat; do
  wasm="${wat%.wat}.wasm"
  echo "wat2wasm $wat -> $wasm"
  wat2wasm --enable-threads "$wat" -o "$wasm"
done
```

(Or restructure into a `find -name '*.wat'` loop.) Confirm WABT version
supports the imports/exports each fixture uses; nothing here needs
`--enable-multi-memory`.
