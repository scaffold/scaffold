# Wire Format

The wire format defines the binary envelope for everything Scaffold sends over the network or persists to storage. A **packet** wraps a JSON payload with a header and optional cryptographic signature. The block's identity hash is the SHA3-256 digest of the entire packet bytes.

Every byte stream Scaffold puts on a peer connection -- blocks, signaling envelopes, sync requests, delivery acks, peer info -- is a packet. Receivers multiplex on the leading `SCF` magic + type byte; bytes that don't start with `SCF` are silently dropped (not a Scaffold packet).

---

## Packet Structure

```
[magic (3B)] [type (1B)] [payload (variable)] [signature (65B, if signed)]
```

| Field | Size | Description |
|-------|------|-------------|
| Magic | 3 bytes | `SCF` = `[83, 67, 70]` -- identifies the protocol |
| Type | 1 byte | `PacketType` enum -- determines structure |
| Payload | variable | UTF-8 JSON bytes (type-tagged via `BlockSerializer`) |
| Signature | 65 bytes | Present only for signed types |

The header is 4 bytes (magic + type). The minimum packet size is 4 bytes (unsigned, empty payload).

---

## PacketType Enum

| Value | Name | Signed | Description |
|-------|------|--------|-------------|
| 0 | `Block` | Yes | Standard signed block |
| 1 | `UnsignedBlock` | No | Aggregation blocks, genesis |
| 2 | `Signal` | No | Encrypted handshake / WebRTC signaling envelope |
| 3 | `Sync` | No | Canonical-tip + depth advertisement |
| 4 | `Request` | No | Block hash request |
| 5 | `Delivery` | No | Delivery acknowledgement |
| 6 | `PeerInfo` | No | Peer identity + supported contracts |

Whether a packet includes a signature is determined entirely by the type -- not by a flag or field. Only `Block` packets are signed; control messages and unsigned blocks (e.g. genesis, aggregation) carry only the JSON payload.

---

## Payload Encoding

The payload is a UTF-8 encoded JSON string produced by `BlockSerializer.serialize()`. This serializer handles type-tagged encoding for:

- `Hash` → `{ __t: 'H', v: hex }`
- `Uint8Array` → `{ __t: 'B', v: base64 }`
- `bigint` → `{ __t: 'N', v: string }`

The payload carries all block fields except `hash`:

```
BlockPayload {
    anchor:         Hash
    aggregates:     Hash[]
    claims:         number[]
    outputs:        Output[]
    declaredWeight: number
    refs:           Hash[]
}
```

Future protocol versions may introduce binary payload encodings for efficiency. The type byte allows the parser to select the appropriate decoder.

---

## Signature Format

For signed packet types, the last 65 bytes of the packet are the signature:

```
[compact signature (64B)] [recovery bit (1B)]
```

- **Compact signature**: 64-byte secp256k1 ECDSA signature (r, s)
- **Recovery bit**: 1 byte (0 or 1) enabling public key recovery without the signer's key

This is the legacy byte order (compact first, recovery last), matching the original FactService format.

---

## Block Identity

The block hash is the SHA3-256 digest of the entire packet bytes:

```
block.hash = SHA3-256(raw_packet_bytes)
```

This means the hash covers the magic, type, payload, and signature (if present). Two packets with different signatures (e.g., different signers for the same payload) produce different block hashes.

The original packet bytes are the canonical form. They are stashed in `NodeContext.packetStore` (keyed by hash) when blocks are locally composed and when block packets arrive from the network. `NetworkBridge` forwards these exact bytes to other peers, and `StorageManager` persists them so signatures survive restarts and signer recovery is always cryptographic -- never trusted from a payload field.

---

## Signing Process

1. Serialize the payload to JSON via `BlockSerializer.serialize()`
2. UTF-8 encode the JSON string
3. Build the header+payload buffer: `[magic (3B)] [type (1B)] [payload bytes]`
4. Compute the message hash: `SHA3-256(header + payload)`
5. Sign the message hash with the private key (secp256k1 ECDSA)
6. Append the signature: `[compact (64B)] [recovery (1B)]`
7. Compute the block hash: `SHA3-256(entire buffer)`

The message being signed is the hash of everything except the signature itself. The block identity hash covers everything including the signature.

---

## Verification Process

Given a raw packet and an expected public key:

1. Parse the packet: validate magic, read type, extract payload and signature
2. Compute `header_payload = raw[0 .. len - 65]`
3. Compute `message_hash = SHA3-256(header_payload)`
4. Verify the secp256k1 signature against `message_hash` and the expected public key

For **signer recovery** (no expected key):

1. Extract `compact` (bytes 0–63 of signature) and `recovery` (byte 64)
2. Recover the public key from `(compact, recovery, message_hash)`
3. Returns the 33-byte compressed secp256k1 public key

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/Packet.ts`](../../src/core/Packet.ts) | Packet compose, parse, sign, verify |
| [`src/core/BlockSerializer.ts`](../../src/core/BlockSerializer.ts) | Type-tagged JSON serialization |
| [`src/node/PeerConnection.ts`](../../src/node/PeerConnection.ts) | Multiplexes inbound packets by type byte |
| [`src/node/NetworkBridge.ts`](../../src/node/NetworkBridge.ts) | Reads `packetStore` to forward original bytes |
| [`src/node/StorageManager.ts`](../../src/node/StorageManager.ts) | Persists raw packet bytes; restores via `parsePacket` |
| [`src/util/Hash.ts`](../../src/util/Hash.ts) | SHA3-256 hashing |
| [`src/util/secp.ts`](../../src/util/secp.ts) | secp256k1 ECDSA |
