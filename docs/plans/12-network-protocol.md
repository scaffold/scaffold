# 12 - Network Protocol

## Summary

Define all message types exchanged between peers over the network. This replaces the old fact-based communication with typed messages.

## Dependencies

- 00-folder-reorganization
- 11-peer-connection

## Design

The wire protocol has these message types:

1. **Block** - a serialized block for gossip distribution
   - `{ type: 'block', block: SerializedBlock }`

2. **Signal** - WebRTC signaling data (SDP offers/answers, ICE candidates)
   - `{ type: 'signal', nonce: string, data: string }`
   - This replaces the old ConnectionSignal facts

3. **Sync** - canonical chain summary for initial handshake
   - `{ type: 'sync', tipHash: string, depth: number, hashes: string[] }`
   - hashes is a sample of known block hashes for efficient diffing

4. **Request** - request specific blocks by hash
   - `{ type: 'request', hashes: string[] }`

5. **Delivery** - gossip delivery report
   - `{ type: 'delivery', blockHash: string, novel: boolean }`
   - Tells the sender whether the block was new to us (for gossip module's delivery matrix)

6. **PeerInfo** - peer metadata for discovery
   - `{ type: 'peerInfo', protocols: string[], addresses: string[] }`

All messages are JSON-serialized for now. Binary format later.

Framing: Each message is a complete JSON object. For messages larger than the transport's max message size, use MessageSplitter.

## Interface

```typescript
type WireMessage =
  | { type: 'block'; block: SerializedBlock }
  | { type: 'signal'; nonce: string; data: string }
  | { type: 'sync'; tipHash: string; depth: number; hashes: string[] }
  | { type: 'request'; hashes: string[] }
  | { type: 'delivery'; blockHash: string; novel: boolean }
  | { type: 'peerInfo'; protocols: string[]; addresses: string[] }
```

## Implementation Notes

- The signal message type solves the WebRTC signaling problem: instead of routing through FactService, signals are sent directly over existing connections to the target peer. For initial connection (before any peer connection exists), signals go through the bootstrap server.
- Delivery reports are lightweight (just a hash + boolean) and can be sent on the fast channel.
- The sync protocol can be simple initially: exchange tip hashes, then request missing blocks.

## Testing

- Test message serialization/deserialization.
- Test that all message types round-trip correctly.
