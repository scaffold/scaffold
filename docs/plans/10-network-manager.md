# 10 - Network Manager

## Summary

NetworkManager starts network plugins, connects to bootstrap peers, manages peer connections, and routes blocks/signals between the library and the network.

## Dependencies

- 00-folder-reorganization
- 02-reactive-layer
- 11-peer-connection

## Design

- NetworkManager class in `src/node/NetworkManager.ts`
- On construction: start each network plugin, passing a NetworkDriver
- NetworkDriver.onConnection() is called by plugins when a peer connects
- On new connection: wrap in PeerConnection, register with gossip module, sync canonical chain
- Bootstrap: for each bootstrapPeer address, tell plugins to resolve and connect
- Peer discovery: periodically (via timePlugin) exchange peer lists with connected peers
- When the reactive layer produces gossip push actions, NetworkManager routes them to the right PeerConnection

## Interface

```typescript
class NetworkManager {
  constructor(plugins: NetworkPlugin[], config: NetworkConfig, reactive: ReactiveLayer)

  // Called by reactive layer for gossip
  sendBlock(block: Block, targets: string[]): void

  // Bootstrap
  bootstrap(addresses: string[]): void

  // Lifecycle
  close(): Promise<void>

  readonly peers: ReadonlyMap<string, PeerConnection>
}
```

## Implementation Notes

- Keep the existing NetworkProvider interface from src/NetworkProvider.ts. The user iterated on this and likes it.
- BUT: the SignalingDriver interface currently has `ctx: Context` which couples it to the old system. This needs to change to not require the old Context. Propose to the user: replace `ctx: Context` with the specific things the driver needs (a way to send signals, a way to create connections). The protocol string, isInitiator, and myToken fields are fine.
- Connection authentication (token-based) from SignalingService should be preserved but decoupled from FactService. Signal delivery needs a new transport - see 12-network-protocol.md.
- For now, start simple: WebSocket connections where each message is a serialized block (JSON).
- Peer discovery can come later.

## Testing

- Test with MockNetworkPlugin.
- Test bootstrap.
- Test block routing.
