# WASI test programs (vendored references)

Pinned versions of every preview1 `.wasm` we run end-to-end against the WASI
shim. The shim only links against `wasi_snapshot_preview1.*`; programs in the
`wasi_unstable.*` or preview2/component-model namespaces are out of scope.

Only **QuickJS** is in scope for the v1 shakedown. PHP / Ruby / Python are
documented here so a future contributor doesn't have to re-discover the
sources, but they land after QuickJS is green.

## QuickJS (in scope, v1 shakedown)

| Field | Value |
|---|---|
| Program | `qjs` (QuickJS-NG) |
| Source repo | https://github.com/quickjs-ng/quickjs |
| Release tag | `v0.14.0` |
| Release commit | `3c051980ab7e783dfbfb1c70c014ce5e05ecf24c` |
| Release date | 2026-04-11 |
| Asset filename | `qjs-wasi.wasm` |
| Download URL | https://github.com/quickjs-ng/quickjs/releases/download/v0.14.0/qjs-wasi.wasm |
| Size | 1,498,776 bytes (1.43 MiB) |
| SHA-256 | `ba8727663e566b4acbe0ac61cb9caae2e880929042ffb8e21af6772034776c5e` |
| Module kind | command (exports `_start`) |
| WASI namespace | `wasi_snapshot_preview1` (preview1 confirmed via `wasm-objdump`) |

The companion artifact `qjs-wasi-reactor.wasm` (1.42 MiB) is the reactor build
of the same source tree (exports `_initialize` plus all the QuickJS C API
symbols). We don't use it for the v1 shakedown but it's the right target
later when we want to call into QuickJS as an embedded library rather than a
CLI.

### WASI imports referenced by the binary (23 total)

```
args_get             environ_get               fd_prestat_dir_name   path_create_directory
args_sizes_get       environ_sizes_get         fd_prestat_get        path_filestat_get
clock_time_get       fd_close                  fd_read               path_filestat_set_times
fd_fdstat_get        fd_fdstat_set_flags       fd_readdir            path_open
fd_seek              fd_write                  poll_oneoff           path_remove_directory
proc_exit                                                            path_rename
                                                                     path_unlink_file
```

Every call here is in our 12-call MVP, the args/env quartet (Phase B
`args_env.zig`), or — for the half-dozen `path_*` write/mutate calls plus
`fd_prestat_*` and `poll_oneoff` — falls into the ENOTSUP / read-only-FS
defaults documented in `docs/design/wasi-shim.md`. Nothing here demands a
14th MVP call.

### `wasi_setup` for the `print("hello")` shakedown

```jsonc
{
  "argv": ["qjs", "-e", "console.log('hello')"],
  "env": {},
  "cwd": "/",
  "preopens": [],
  "stdin":  "/dev/null",
  "stdout": "/out/debug",
  "stderr": "/out/debug"
}
```

`preopens: []` keeps `fd_prestat_get(3)` returning `EBADF` immediately, which
matches what wasi-libc startup expects when no directories were granted. The
shim's defaults would preopen `/in /out /scratch /dev`; for the shakedown we
override to empty so the trace stays minimal — assert sequence is
`args_sizes_get → args_get → environ_sizes_get → environ_get → fd_prestat_get(3) → fd_write(1, "hello\n") → proc_exit(0)`.

### Why this build and not `saghul/wasi-lab` or `wasmer.io/saghul/quickjs`

There are two older QuickJS-on-WASI distributions in the wild:

| Source | Status | Why we skipped it |
|---|---|---|
| `saghul/wasi-lab/qjs-wasi` (wapm.io `_/quickjs@0.0.3`) | Last touched 2021 | Imports from `wasi_unstable.*`, NOT `wasi_snapshot_preview1.*`. Functionally equivalent calls, but our shim only exports the canonical preview1 namespace, so this would require an aliasing layer for no benefit. |
| `vercel-labs/quickjs-wasi@2.2.0` (npm) | Active | Reactor module; also imports six non-WASI `env.host_*` callbacks (`host_call`, `host_module_load`, …). Not a CLI — you have to drive evaluation from the JS host. Wrong shape for "stdin → eval → stdout" shakedown. |

The upstream `quickjs-ng/quickjs` release ships the clean, command-mode,
preview1 binary directly; that's the one to vendor.

---

## PHP (deferred — second batch)

| Field | Value |
|---|---|
| Program | `php-cgi` (slim build) |
| Source repo | https://github.com/vmware-labs/webassembly-language-runtimes |
| Release tag | `php/8.2.6+20230714-11be424` |
| Release commit | `11be424` |
| Release date | 2023-07-14 |
| Asset filename | `php-cgi-8.2.6-slim.wasm` |
| Download URL | https://github.com/vmware-labs/webassembly-language-runtimes/releases/download/php/8.2.6%2B20230714-11be424/php-cgi-8.2.6-slim.wasm |
| Size | 6,259,973 bytes (5.97 MiB) |
| SHA-256 | `4fd2e8c42ae529ba72f88a0f1e46de1fc69a4b4f01e01fedd65ca966b8ffe6fa` |
| Module kind | command (exports `_start`) |
| WASI namespace | `wasi_snapshot_preview1` (preview1; built with wasi-sdk) |

The "slim" suffix means built without the bundled extensions tarball — same
binary, smaller payload. The full `php-cgi-8.2.6.wasm` (12.55 MiB) and the
WasmEdge-targeted variants (`*-wasmedge.wasm`, which import a non-portable
`wasmedge_*` socket namespace) are also in the release; we want the slim
preview1 variant.

`wasi_setup` shape (CGI: program reads request via stdin + environment):

```jsonc
{
  "argv": ["php-cgi"],
  "env": {
    "REQUEST_METHOD": "GET",
    "SCRIPT_FILENAME": "/in/params",
    "QUERY_STRING": "",
    "CONTENT_LENGTH": "0",
    "GATEWAY_INTERFACE": "CGI/1.1",
    "SERVER_PROTOCOL": "HTTP/1.1"
  },
  "cwd": "/in",
  "preopens": ["/in", "/out"],
  "stdin":  "/in/body",
  "stdout": "/out/record/response",
  "stderr": "/out/debug"
}
```

CGI vars are illustrative; the real set depends on what the program does.
Stresses `environ_get`, `fd_read` from stdin, `fd_write` to stdout.

## Ruby (deferred — second batch)

| Field | Value |
|---|---|
| Program | `ruby` (slim build) |
| Source repo | https://github.com/vmware-labs/webassembly-language-runtimes |
| Release tag | `ruby/3.2.2+20230714-11be424` |
| Release commit | `11be424` |
| Release date | 2023-07-14 |
| Asset filename | `ruby-3.2.2-slim.wasm` |
| Download URL | https://github.com/vmware-labs/webassembly-language-runtimes/releases/download/ruby/3.2.2%2B20230714-11be424/ruby-3.2.2-slim.wasm |
| Size | 8,239,563 bytes (7.86 MiB) |
| SHA-256 | `de598f394e398763d2b147e3e51a6eeadf048128598ac4a3f992a97204c192b0` |
| Module kind | command (exports `_start`) |
| WASI namespace | `wasi_snapshot_preview1` (preview1; built with wasi-sdk) |

Slim variant. The full `ruby-3.2.2.wasm` (23.34 MiB) bundles the stdlib via
extra preopens and is unnecessary for our smoke test. `wasi_setup` for a
`puts "hello"` smoke run:

```jsonc
{
  "argv": ["ruby", "-e", "puts 'hello'"],
  "env": {},
  "cwd": "/",
  "preopens": ["/scratch"],
  "stdin":  "/dev/null",
  "stdout": "/out/debug",
  "stderr": "/out/debug"
}
```

Fewer preopens than PHP/Python; mostly exercises the same FD/path surface as
QuickJS plus heavier `clock_time_get` traffic from Ruby's GC.

## Python (deferred — second batch)

| Field | Value |
|---|---|
| Program | CPython |
| Source repo | https://github.com/vmware-labs/webassembly-language-runtimes |
| Release tag | `python/3.12.0+20231211-040d5a6` |
| Release commit | `040d5a6` |
| Release date | 2023-12-11 |
| Asset filename | `python-3.12.0.wasm` |
| Download URL | https://github.com/vmware-labs/webassembly-language-runtimes/releases/download/python/3.12.0%2B20231211-040d5a6/python-3.12.0.wasm |
| Size | 26,267,204 bytes (25.05 MiB) |
| SHA-256 | `e5dc5a398b07b54ea8fdb503bf68fb583d533f10ec3f930963e02b9505f7a763` |
| Module kind | command (exports `_start`) |
| WASI namespace | `wasi_snapshot_preview1` (preview1; built with wasi-sdk 20.0) |

The `python-3.12.0-wasi-sdk-20.0.tar.gz` tarball alongside it ships the
matching stdlib mount (`Lib/`); both are needed at runtime because CPython
walks `import` statements as `path_open` calls under a preopened
`/usr/local/lib/python3.12`.

`wasi_setup` for `print("hello")` once we have the stdlib mount strategy
nailed down:

```jsonc
{
  "argv": ["python3.12", "-c", "print('hello')"],
  "env": {
    "PYTHONHOME": "/python",
    "PYTHONPATH": "/python/lib/python3.12"
  },
  "cwd": "/",
  "preopens": ["/python", "/scratch"],
  "stdin":  "/dev/null",
  "stdout": "/out/debug",
  "stderr": "/out/debug"
}
```

Open question for that batch: how the stdlib mount lands as a scaffold
input. Likely `/in/fetch/0x.../<stdlib-record-key>` mapped to a synthetic
`/python/lib/python3.12/...` view. Out of scope until QuickJS works.

The wasmedge-targeted variant (`python-3.12.0-wasmedge.wasm`, 12.75 MiB) is
not interchangeable — it imports `wasmedge_*` host functions outside the
preview1 namespace.

---

## Why these programs and not the others

The design doc rules out the two obvious "real-world WASI compute" targets:

> **SpiderMonkey** is `wasi-component-model` (preview2) only; not a viable
> preview1 target. **SQLite CLI** lacks a clean standalone preview1 `.wasm`
> — `sqlite.org`'s WASM is browser-Emscripten; `wasmer/sqlite` package is
> from 2019 and unmaintained. Defer both unless a maintained build appears.
> — `docs/design/wasi-shim.md`, "Real-world end-to-end"

So neither of those reaches the vendor list. The four programs above span
the size/complexity ladder the design lays out (QuickJS ≈1.4 MiB, PHP-cgi
≈6 MiB, Ruby ≈8 MiB, Python ≈25 MiB) without overlapping each other on the
WASI surface they exercise — QuickJS hits stdio + args/env, PHP stresses
`environ_get`, Ruby is the "neither minimal nor enormous" middle case, and
Python is the graduation target that touches the entire FD/path layer
because every Python `import` is a `path_open` walk. If a maintained
preview1 SpiderMonkey or SQLite build shows up later, it slots in here.
