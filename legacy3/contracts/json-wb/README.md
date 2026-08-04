# json-wb

The generic JSON walker/builder contract module. A small freestanding Zig WASM
blob (`json-wb.wasm`) that implements the scaffold build/walk ABI for **any**
contract whose params/data are JSON -- so the params and results of such a
contract can be serialized and deserialized the same way by any host, without
contract-specific code.

It is wired as an extra layer (`json_wb`) in a contract's `modules` spec:

```
base.imports:
  build_params -> json_wb:build_params
  walk_params  -> json_wb:walk_params
  build_data   -> json_wb:build_data
  walk_data    -> json_wb:walk_data
```

## Direction

- **build** (`build_params` / `build_data`): assemble canonical JSON bytes by
  querying the host builder. `request_value_type` tells the module each value's
  type; it then dispatches -- `request_string` / `request_number` /
  `request_bool` for scalars, `request_array_length` to iterate arrays,
  `request_object_keys` (sorted for canonical key order) to recurse objects.
  The host resolves each request against the query `Reader` it holds (see
  `src/plugins/wasm/WasmHostBridge.ts` `makeBuildBridge`), tracking position via
  `begin_*` / `end_*`.

- **walk** (`walk_params` / `walk_data`): parse JSON bytes and stream
  `scaffold_walker.emit_*` calls (objects -> map_start/end, arrays ->
  list_start/end with index keys, scalars -> emit_string/number/bool). A
  self-contained recursive-descent parser with number and `\uXXXX` support.

## ABI notes

- See `docs/protocol/wasm-abi.md` for the full `scaffold_builder.*` /
  `scaffold_walker.*` import surface, including `request_value_type` and
  `request_object_keys` (which this module relies on).
- Top-level values are emitted/requested under the empty key `""`, matching the
  host's walker-tree-to-object mapping.
- The module exports its own `memory` and `alloc`; the host writes request
  replies (and the walk input) into the bump arena via `alloc`. The walk path
  must NOT reset the arena -- the input JSON already lives there.

## Build

```sh
deno task build:json-wb     # -> dist/json-wb.wasm
```

`well-known-blocks/json-wb` packages the blob as a HASH_CONTRACT block seeded
into every node, so contracts that reference it resolve the blob offline.
Tested in isolation by `tests/JsonWb.test.ts` (build, walk, round-trip).
