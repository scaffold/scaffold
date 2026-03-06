# Output Data Format

> Status: design discussion. Not yet implemented.

## Context

Each block output carries a `data: Uint8Array` field. The protocol treats
this as opaque bytes — only the contract identified by `output.contract`
knows how to interpret them. The question is whether to standardize the
encoding, and how to make output data inspectable by generic tools.

## Current state

Two contracts exist, each using a different encoding:

- **StatusContract**: hand-packed binary. `[33 bytes pubkey][UTF-8 message]`.
  Compact, deterministic, but requires contract-specific code to read.
- **AggregationContract**: JSON serialized to UTF-8 bytes. Human-readable,
  but can't represent binary data without base64, and JSON key ordering
  isn't guaranteed across implementations.

## Options considered

### Raw Uint8Array (status quo)

Each contract invents its own encoding. Maximum flexibility, zero
dependencies. The downside is no generic tooling — every consumer needs
contract-specific decoders, and ad-hoc formats are error-prone.

### JSON-in-bytes

Human-readable, zero-dependency, good for structured data with no binary
fields. Fails for binary data (public keys, hashes) without base64
inflation. Non-deterministic key ordering is a concern when output data
feeds into block hashing.

### MessagePack

Compact binary format with structured data and binary support. Widely
supported. However, the spec has ambiguities around integer widths and
lacks a standardized deterministic encoding mode.

### CBOR (RFC 8949)

IETF standard for concise binary encoding. Supports binary data natively,
has a deterministic encoding mode (RFC 8949 Section 4.2), and is well
specified. A good general-purpose choice if we wanted to standardize on a
single encoding. Minimal implementations are small (~200 lines).

The downside is coupling every contract to a specific encoding format.
Simple contracts that just store a hash or a public key pay the overhead
of a structured encoding they don't need.

### Recursive Map\<bytes, bytes\>

A minimal self-describing structure: each node is either a leaf (byte
array) or a map from byte arrays to byte arrays. Simpler than CBOR, but
loses too much — no distinction between numbers, strings, arrays, and
binary. Everything becomes "bytes you need to know how to interpret," and
you end up reimplementing type tags on top, arriving at a worse CBOR.

## Chosen direction: contract-as-explorer

Rather than standardizing an encoding, let the contract itself act as the
interpreter of its own data. Contracts optionally export a small set of
WASM functions that allow walking output data like a filesystem:

```
list(data, path) -> [key1, key2, ...]     // like ls
read(data, path) -> bytes                 // like cat
type(data, path) -> "map"|"bytes"|"string"|"number"  // like stat
```

Where `path` is a sequence of keys, e.g. `["claimMask", "chunks", "0"]`.

### Why this works

**Encoding stays private.** Each contract uses whatever format is natural
for its data — CBOR, JSON, hand-packed binary, protobuf. The protocol
never needs to know. No encoding dependency, no format to standardize.

**Single source of truth.** The code that produces the data is the same
code that interprets it. No risk of encoder/decoder version skew.

**Generic tooling for free.** A block explorer calls `list()` and `read()`
recursively and renders a tree view. This works for every contract,
present and future, without contract-specific UI code.

**Graceful spectrum of complexity.** A simple contract (signature: just a
public key) implements `read(data, []) -> data` and
`type(data, []) -> "bytes"`. One function. A complex contract
(aggregation) exposes a rich tree with nested structure. The interface
scales without forcing overhead on simple cases.

### Layering

1. **Wire format.** `Output.data` is `Uint8Array`. Opaque to the protocol.
   Each contract chooses its own encoding. Determinism is the contract's
   responsibility.

2. **Protocol-internal access.** Standard contracts (aggregation, signature,
   collateral) have native encode/decode helpers in TypeScript
   (e.g. `encodeAggregationData`, `decodeStatusData`). Service adapters
   call these directly. Fast, no WASM overhead.

3. **Contract-exposed exploration.** Contracts optionally export `list`,
   `read`, `type` WASM functions. Generic tools (block explorers,
   debuggers, CLI utilities) use these to walk any output's data without
   knowing the encoding.

### Open questions

- **Mandatory vs optional.** Should the explorer interface be required of
  all contracts? Mandatory means all data is always inspectable but adds
  work for contract authors. Optional means simpler contracts can skip it
  but tooling has gaps for unexplored contracts.

- **Path representation.** Paths could be string arrays, byte array arrays,
  or a single delimited string. String arrays are the most natural for
  human interaction but assume keys are UTF-8.

- **Display hints.** `type()` returns a basic type tag. Contracts might
  want to provide richer hints — "this is a hex-encoded hash", "this is a
  human-readable name". Whether this belongs in the explorer interface or
  in separate contract metadata is unclear.

- **Streaming / large data.** If an output's data is large, `read()` at
  the root returns everything. A `size(data, path)` function or chunked
  reading might be needed, though this is unlikely to matter in practice
  given typical output sizes.
