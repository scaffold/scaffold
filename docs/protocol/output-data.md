# Output Data Format

> Status: design direction chosen. Not yet implemented.

## Context

Each block output carries two opaque byte fields: `verifier.params` (spending
condition parameters) and `data` (application payload). The protocol treats
both as raw `Uint8Array` -- only the contract identified by
`verifier.contract` knows how to interpret them.

`data` is additionally optional: an omitted `data` denotes a **pure-incentive
output** (value without payload, invisible to contracts, not emittable by
contracts). See [Data-less Outputs](computation.md#data-less-outputs) in the
computation doc for semantics. The walker/builder interface described below
applies only to data-bearing outputs -- data-less outputs have nothing to walk
or build.

The challenge: generic tools (block explorers, block creation UIs, debuggers)
need to read and write these fields without contract-specific code. This
document specifies the **bidirectional walker/builder** interface that
contracts optionally export to support this.

## Background

Two concerns drove this design:

1. **Observability**: inspecting existing params/data in a block explorer.
2. **Construction**: creating new params/data in a block creation UI.

The original contract-as-explorer design (path-based `list`/`read`/`type`)
handled observability but not construction. The bidirectional walker/builder
unifies both directions under a single contract interface.

## Options Considered

Several encoding-level approaches were evaluated and rejected:

- **Raw Uint8Array (status quo)**: maximum flexibility, zero generic tooling.
- **JSON-in-bytes**: human-readable but no binary support, non-deterministic.
- **MessagePack**: compact but ambiguous integer widths, no deterministic mode.
- **CBOR**: well-specified but couples every contract to a single format.

The conclusion: don't standardize the encoding. Let contracts choose their own
wire format and instead standardize the **interpretation interface** -- a small
set of functions the contract exports so generic tools can read and write its
data without knowing the encoding.

---

## Chosen Direction: Bidirectional Walker/Builder

Contracts optionally export four functions -- two for reading (walker) and two
for writing (builder):

```
// Reading: contract walks existing bytes, calling host emit functions
walk_params(params_ptr, params_len) -> void
walk_data(data_ptr, data_len) -> void

// Writing: contract requests field values from host, serializes to bytes
build_params() -> void
build_data() -> void
```

All four are optional. A contract can export any subset.

### Why This Works

**Encoding stays private.** Each contract uses whatever format is natural --
JSON, CBOR, hand-packed binary, protobuf. The protocol never needs to know.

**Single source of truth.** The same contract code that produces and verifies
the data also drives its interpretation and construction. No risk of
encoder/decoder version skew.

**Generic tooling for free.** A block explorer calls `walk_data()` and renders
a tree view. A block creation UI calls `build_params()` and renders a form.
Both work for every contract without contract-specific UI code.

**Graceful spectrum of complexity.** A simple contract (signature: just a
public key) exports a 3-line builder. A complex contract (aggregation) exposes
a rich tree with nested structure. The interface scales without forcing
overhead on simple cases.

---

## Value Descriptors

Every field the contract emits (walker) or requests (builder) carries a
**value descriptor** -- a JSON object that tells the host what the field means:

```
interface ValueDescriptor {
    type: string;                // MIME-ish type hierarchy
    shortDescription: string;    // single-line summary
    markdownDescription?: string;
    options?: EnumOption[];       // if set, field is an enum
}

interface EnumOption {
    value: boolean | number | string;
    shortDescription: string;
    markdownDescription?: string;
}
```

The descriptor is encoded as a JSON string in the WASM interface. TypeScript
contracts pass it as a native object.

### Type Hierarchy

The `type` field uses a MIME-inspired hierarchical format. The host matches
from most specific to least specific, falling back gracefully:

```
bytes                                   -> raw hex input
bytes/hash                              -> hash display
bytes/hash/sha256                       -> sha256 validation
bytes/hash/sha256/scaffold/block        -> block hash picker
bytes/hash/sha256/scaffold/contract     -> contract autocomplete
bytes/public_key                        -> key dropdown
bytes/public_key/ed25519                -> ed25519 validation
i32                                     -> numeric input
i32/timestamp/ms                        -> datetime picker
i32/value                               -> amount input
string/utf8                             -> text input
bool                                    -> checkbox / toggle
```

A host that recognizes `bytes/public_key/ed25519` shows a specialized widget.
A simpler host that only recognizes `bytes/public_key` shows its generic key
picker. A minimal host that only recognizes `bytes` shows a hex input. There
is always a fallback.

New type qualifiers can be introduced by any contract. Unrecognized qualifiers
fall back to the base type.

### Enum Fields

When `options` is present on a descriptor, the field is an enum. The host
renders a dropdown or equivalent selection UI. The `value` on each option is
the concrete value the contract will receive.

There is no separate `request_select` host function -- the same
`request_number` or `request_string` is used. The descriptor's `options`
array determines whether the host renders a free input or a selection.

---

## Reading: The Walker

> The host-import signatures shown in this and the following section are illustrative. The exact binary surface (import names, parameter widths, packed-pointer return convention, error semantics) is normatively specified in [wasm-abi.md](wasm-abi.md).

The walker lets generic tools inspect existing params/data. The contract
receives the raw bytes and calls host-imported `emit_*` functions to describe
the structure:

### Host Imports (Walker Mode)

```
emit_bytes(key_ptr, key_len, value_ptr, value_len,
           desc_ptr, desc_len) -> void
emit_string(key_ptr, key_len, value_ptr, value_len,
            desc_ptr, desc_len) -> void
emit_number(key_ptr, key_len, value: f64,
            desc_ptr, desc_len) -> void
emit_bool(key_ptr, key_len, value: u32,
          desc_ptr, desc_len) -> void

emit_map_start(key_ptr, key_len) -> bool    // false = skip branch
emit_map_end() -> void
emit_list_start(key_ptr, key_len, count: u32) -> bool
emit_list_end() -> void
```

Each `emit_*` call includes a descriptor (JSON string) with the type hint and
description. The host uses this to render the value appropriately.

The host can return `false` from `emit_map_start` / `emit_list_start` to skip
a branch, enabling lazy exploration of large structures.

### Example: Signature Contract Walker

```rust
fn walk_params(params: &[u8]) {
    emit_bytes("", params, r#"{"type":"bytes/public_key/ed25519",
        "shortDescription":"Owner public key"}"#);
}
// No walk_data -- signature outputs have no meaningful data.
```

### Example: Collateral Contract Walker

```rust
fn walk_data(data: &[u8]) {
    let detail = decode(data);
    emit_map_start("collateral");
    emit_string("side", detail.side, r#"{"type":"string/utf8",
        "shortDescription":"Collateral side",
        "options":[
            {"value":"for","shortDescription":"Publisher stake"},
            {"value":"against","shortDescription":"Challenger bond"}
        ]}"#);
    emit_bytes("pubkey", detail.pubkey, r#"{"type":"bytes/public_key/ed25519",
        "shortDescription":"Owner public key"}"#);
    if detail.side == "against" {
        emit_map_start("target");
        emit_string("type", detail.target.type, r#"{"type":"string/utf8",
            "shortDescription":"Challenge target type"}"#);
        if has_index(detail.target) {
            emit_number("index", detail.target.index,
                r#"{"type":"i32","shortDescription":"Target index"}"#);
        }
        emit_map_end();
    }
    emit_map_end();
}

fn walk_params(params: &[u8]) {
    emit_bytes("", params, r#"{"type":"bytes/hash/sha256/scaffold/block",
        "shortDescription":"Target block hash"}"#);
}
```

---

## Writing: The Builder

The builder lets generic tools construct new params/data. The contract drives
the process, requesting field values from the host and serializing the result:

### Host Imports (Builder Mode)

```
// Value requests -- descriptor is a JSON string
request_bytes(key_ptr, key_len, desc_ptr, desc_len) -> (ptr, len)
request_string(key_ptr, key_len, desc_ptr, desc_len) -> (ptr, len)
request_number(key_ptr, key_len, desc_ptr, desc_len) -> f64
request_bool(key_ptr, key_len, desc_ptr, desc_len) -> u32
request_array_length(key_ptr, key_len, desc_ptr, desc_len) -> u32

// Structure
begin_object(key_ptr, key_len) -> void
end_object() -> void
begin_array(key_ptr, key_len) -> void
end_array() -> void

// Output
set_result(ptr, len) -> void

// Validation
validation_error(key_ptr, key_len, msg_ptr, msg_len) -> void
```

The contract calls `request_*` functions in order. The host returns the user's
value for each field (or a default). The contract validates as it receives
data, calling `validation_error` for any problems. Finally, `set_result`
provides the serialized bytes.

### Default-Then-Refine Execution

The host runs the builder using a **default-then-refine** model:

1. **Initial run**: Call `build_params()`. The host returns defaults for every
   `request_*` call: first enum option for enums, 0 for numbers, empty bytes
   for byte fields. Record all field requests (names, descriptors, structure)
   and the resulting default values.

2. **Render**: Convert the recorded field tree into a form or editor. The
   descriptors provide all the metadata needed: type hints for widgets, enum
   options for dropdowns, descriptions for labels and documentation.

3. **Refinement**: When the user changes a field, re-run the builder. The host
   returns the user's values for fields that have been set and defaults for the
   rest. The builder may produce different fields on this run (conditional
   branches), which updates the form accordingly.

4. **Final run**: When the user submits, run the builder one last time with all
   final values. The contract validates and calls `set_result` with the
   serialized bytes.

There is no separate schema discovery phase. The builder always produces a
concrete default object. The schema is a side-effect of recording which
`request_*` calls the builder makes.

### Validation

The builder should validate field values as it receives them. When validation
fails, the contract calls `validation_error(key, message)` to report the
problem. The host collects errors and displays them to the user. The contract
may continue (to validate remaining fields) or abort early.

### Example: Signature Contract Builder

```rust
fn build_params() {
    let pk = request_bytes("publicKey", r#"{"type":"bytes/public_key/ed25519",
        "shortDescription":"Owner public key"}"#);
    if pk.len() != 33 {
        validation_error("publicKey", "Public key must be 33 bytes");
    }
    set_result(pk);
}
// No build_data -- signature outputs have no meaningful data.
```

### Example: Collateral Contract Builder

```rust
fn build_data() {
    begin_object("collateral");
    let side = request_string("side", r#"{"type":"string/utf8",
        "shortDescription":"Collateral side",
        "options":[
            {"value":"for","shortDescription":"Publisher stake"},
            {"value":"against","shortDescription":"Challenger bond"}
        ]}"#);
    let pubkey = request_bytes("pubkey", r#"{"type":"bytes/public_key/ed25519",
        "shortDescription":"Owner public key"}"#);

    let target = if side == "against" {
        begin_object("target");
        let target_type = request_string("type", r#"{"type":"string/utf8",
            "shortDescription":"Challenge target type",
            "options":[
                {"value":"validity","shortDescription":"General validity"},
                {"value":"anchor","shortDescription":"Anchor correctness"},
                {"value":"ref","shortDescription":"Reference validity"},
                {"value":"aggregate","shortDescription":"Aggregate validity"},
                {"value":"output_verifier_contract",
                 "shortDescription":"Output verifier contract"}
            ]}"#);
        let index = if needs_index(target_type) {
            Some(request_number("index",
                r#"{"type":"i32","shortDescription":"Target index"}"#))
        } else { None };
        end_object();
        Some(ChallengeTarget { type: target_type, index })
    } else { None };

    end_object();
    set_result(encode_collateral_detail(side, pubkey, target));
}
```

When `side` changes from "for" to "against", the next refinement run produces
the `target` group. The host detects the new fields and updates the form.

### Example: Array Fields

```rust
fn build_data() {
    begin_object("listing");
    let title = request_string("title",
        r#"{"type":"string/utf8","shortDescription":"Item title"}"#);
    let price = request_number("price",
        r#"{"type":"i32/value","shortDescription":"Asking price"}"#);

    let tag_count = request_array_length("tags",
        r#"{"type":"string/utf8","shortDescription":"Tag"}"#);
    begin_array("tags");
    for i in 0..tag_count {
        request_string(&i.to_string(),
            r#"{"type":"string/utf8","shortDescription":"Tag"}"#);
    }
    end_array();

    end_object();
    set_result(encode_listing(title, price, tags));
}
```

The `request_array_length` call tells the host "this is a variable-length list
of items matching this descriptor." On the initial default run, the host
returns 0. The user can add items in the UI; each refinement run returns the
new count.

---

## Layering

1. **Wire format.** `verifier.params` and `output.data` are `Uint8Array`.
   Opaque to the protocol. Each contract chooses its own encoding. Determinism
   is the contract's responsibility.

2. **Protocol-internal access.** Standard contracts (aggregation, signature,
   collateral) have native encode/decode helpers in TypeScript (e.g.
   `encodeAggregationData`, `decodeCollateralDetail`). Service adapters call
   these directly. Fast, no WASM overhead.

3. **Contract-exposed walker/builder.** Contracts optionally export `walk_*`
   and `build_*` WASM functions. Generic tools use these to read and write any
   output's params/data without knowing the encoding.

Layer 2 is a performance optimization for standard contracts. Layer 3 is the
general mechanism that works for any contract, including third-party ones.
Both layers produce/consume the same bytes.

---

## TypeScript Bridge

Standard contracts and TypeScript-based tooling use a native interface
equivalent to the WASM host imports:

```typescript
interface ContractUI {
    walkParams?(params: Uint8Array, host: WalkerHost): void;
    walkData?(data: Uint8Array, host: WalkerHost): void;
    buildParams?(reader: (descriptor: string) => MaybePromise<Reader>): MaybePromise<Uint8Array>;
    buildData?(reader: (descriptor: string) => MaybePromise<Reader>): MaybePromise<Uint8Array>;
}

interface ValueDescriptor {
    type: string;
    shortDescription: string;
    markdownDescription?: string;
    options?: EnumOption[];
}

interface EnumOption {
    value: boolean | number | string;
    shortDescription: string;
    markdownDescription?: string;
}

interface WalkerHost {
    emitBytes(key: string, value: Uint8Array, desc: ValueDescriptor): void;
    emitString(key: string, value: string, desc: ValueDescriptor): void;
    emitNumber(key: string, value: number, desc: ValueDescriptor): void;
    emitBool(key: string, value: boolean, desc: ValueDescriptor): void;
    emitMapStart(key: string): boolean;
    emitMapEnd(): void;
    emitListStart(key: string, count: number): boolean;
    emitListEnd(): void;
}

// The builder reads user input from a query `Reader` (src/interfaces/Reader.ts):
// a lazy, possibly-async tree of typed values discriminated by `ValueType`.
type Reader =
    | { type: ValueType.Null }
    | { type: ValueType.Bool; value: boolean }
    | { type: ValueType.Number; value: number }
    | { type: ValueType.Bytes; value: Uint8Array }
    | { type: ValueType.String; value: string }
    | { type: ValueType.Array; length: number; at(i: number, descriptor: string): MaybePromise<Reader> }
    | { type: ValueType.Object; keys: string[]; at(key: string, descriptor: string): MaybePromise<Reader> };
```

The walker emits a value tree (the contract drives the host); the builder
*reads* one (the host drives the contract). The runtime adapts the `Reader`
to the `scaffold_builder.*` imports (see `makeBuildBridge`): it holds a cursor
over the tree, `begin_*` / `end_*` move it, and `request_*` read children of the
current node. The WASM interface passes descriptors as JSON strings; the
TypeScript interface passes native objects. Because a `Reader` may resolve
asynchronously, builder methods are `MaybePromise`; the in-process transport
requires synchronous reads while JSPI/Atomics suspend on async ones.

---

## UI Integration

The builder interface is designed to integrate with a **YAML editor** backed
by Monaco and `monaco-yaml`. The pipeline:

1. Run the builder. Record all `request_*` / `begin_*` / `end_*` calls.
2. Convert the recorded field tree into a **JSON Schema** (descriptors map
   naturally: `type` -> JSON Schema type, `options` -> `enum` +
   `markdownEnumDescriptions`, `shortDescription` -> `description`).
3. Render a Monaco YAML editor with that schema. The user gets autocomplete,
   validation, hover docs, and enum dropdowns for free.
4. When the user edits, parse the YAML, re-run the builder with updated
   values, and update the schema if the field tree changed.

Bytes fields use hex encoding in YAML (e.g. `publicKey: 0x3a7f...`). When a
type hint like `bytes/public_key/ed25519` is present, the host can also offer
autocomplete from its known-keys registry, resolving labels to hex values.

---

## Resolved Design Questions

- **Mandatory vs optional.** All four exports (`walk_params`, `walk_data`,
  `build_params`, `build_data`) are optional. Contracts that omit them fall
  back to raw hex display/input in generic tools. Standard contracts have
  TypeScript helpers as a fast path regardless.

- **Path representation.** Superseded. The walker uses `emit_*` calls with
  keys rather than path-based access. Keys are UTF-8 strings. The call
  sequence implicitly defines the tree structure.

- **Display hints.** Resolved by value descriptors. The `type` field carries
  a hierarchical type hint, and `shortDescription`/`markdownDescription`
  provide human-readable context.

- **Streaming / large data.** The walker's `emit_map_start`/`emit_list_start`
  return a boolean allowing the host to skip branches. This supports lazy
  exploration without a separate streaming mechanism.

- **Default values.** Not part of the builder interface. The host provides
  sensible defaults (0, empty, first enum option) during the initial run.
  Contracts do not specify defaults.

---

## Interaction with Other Modules

| Module | Impact |
|--------|--------|
| [Computation](computation.md) | Walker/builder is the observability interface referenced there. Applies to params, data, and self-claimed outputs. |
| [Contracts](contracts.md) | Standard contracts can optionally implement `ContractUI` alongside `ContractFn`. |
| [Block Creation](block-creation.md) | The block creation UI uses builders to construct output params/data fields. |

---

## Implementation

| File | Description |
|------|-------------|
| Future: `src/core/ContractUI.ts` | `ContractUI`, `WalkerHost`, `BuilderHost`, `ValueDescriptor` interfaces |
| Future: WASM host bindings | Walker/builder host function implementations for the WASM runtime |
| Future: `viz/` or `demo/` | YAML editor integration using Monaco + `monaco-yaml` |
