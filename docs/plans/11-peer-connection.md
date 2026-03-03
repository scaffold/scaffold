# 11 - Peer Connection

## Summary

PeerConnection wraps a TransportConnection (from network plugin) with block serialization, message framing, and the sync protocol.

## Dependencies

- 00-folder-reorganization

## Design

- PeerConnection class in `src/node/PeerConnection.ts`
- Wraps a raw transport connection (sendReliable, sendFast, onData, onClose, close)
- Message types over the wire:
  1. `block` - a serialized block
  2. `signal` - WebRTC/signaling data
  3. `sync` - canonical chain summary for initial sync
  4. `request` - request a specific block by hash
  5. `delivery` - gossip delivery report (for gossip module's reportDelivery)
- Serialization: JSON for now (BlockSerializer for blocks)
- Message framing: each message is `{ type: string, payload: string }` JSON
- On received block: deserialize and pass to ReactiveLayer.processBlock()
- Message splitting for large blocks (reuse MessageSplitter from util/)

## Interface

```typescript
class PeerConnection {
  readonly peerId: string

  sendBlock(block: Block): void
  sendSignal(signal: string): void
  sendSync(summary: ChainSummary): void
  requestBlock(hash: Hash): void
  reportDelivery(blockHash: Hash, wasNovel: boolean): void

  close(): void
}
```

## Implementation Notes

- peerId could be derived from the remote public key or assigned during handshake.
- For sync: on connect, each side sends their canonical chain tip hash + depth. The peer with fewer blocks requests the missing ones.
- MessageSplitter handles MTU fragmentation transparently.
- The gossip module needs delivery reports to update its delivery matrix. When we send a block and get a response (or lack thereof), we report to gossip.

## Testing

- Test serialization round-trip.
- Test message framing.
- Test sync protocol.
