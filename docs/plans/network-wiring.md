# Plan: Wire Up Network Plugins

## Goal
Connect the existing network transport plugins (WebRTC, WebSocket, Mock) to the protocol stack so blocks flow between real peers.

## What Exists

**Transport plugins** (all implemented):
- `plugins/browser/WebrtcProvider.ts` — WebRTC data channels with STUN
- `plugins/deno/WebsocketServerProvider.ts` — Deno WS server
- `plugins/WebsocketClientProvider.ts` — Browser WS client
- `plugins/MockNetworkProvider.ts` — In-memory with configurable latency/loss

**Node layer** (all implemented):
- `NetworkManager` — plugin lifecycle, peer map, `sendBlock(block, targets?)`
- `PeerConnection` — message serialization, block/signal/sync/request routing
- `BlockSerializer` — Block ↔ JSON via BlockSerializer.ts
- `Coordinator.blockReceived(block, fromPeer)` — protocol entry point
- `GossipModule.addPeer/removePeer` — peer set management

**The gap**: No code connects NetworkManager events to the coordinator or gossip push actions to NetworkManager.sendBlock.

## What Needs to Be Done

1. **Add NetworkManager to Scaffold** (or NodeContext):
   ```
   NetworkManager receives block → coordinator.blockReceived(block, peerId)
   ```

2. **Wire gossip push actions to network sends**:
   After `coordinator.blockReceived` returns `pushActions`, call `networkManager.sendBlock(block, pushAction.peer)` for each action.

3. **Peer lifecycle sync**:
   - `PeerConnection` opens → `gossip.addPeer(peerId, pubkey, awareness)`
   - `PeerConnection` closes → `gossip.removePeer(peerId)`
   - `PeerConnection.onPeerInfo` → update gossip peer metadata

4. **Block request handling**:
   - `PeerConnection.onRequest(hashes)` → look up blocks in store, send them back
   - `PeerConnection.onSync(tips, depth)` → compare with local canonical tips, request missing blocks

5. **Scaffold.connect(addresses)** — public API to bootstrap connections

6. **Tests**: Use MockNetworkProvider in integration tests

## Open Questions
See docs/questions.md — signaling for WebRTC, awareness implementation.
