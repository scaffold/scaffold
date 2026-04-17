# Transport Layer

The transport layer is how Scaffold nodes establish authenticated point-to-point connections with each other. It abstracts over WebRTC, WebSocket, Unix sockets, or any other byte-level transport, and provides the protocol stack above it with a uniform `TransportConnection` interface.

This layer has two responsibilities:

1. **Publish reachability** -- broadcast the addresses at which this node can be reached (e.g. `wss://host:8314/`, `/tmp/scaffold-abc.sock`), so other peers can bootstrap into the network.
2. **Establish authenticated connections** -- negotiate a session with a specific remote peer identified by their long-term secp256k1 public key, and produce a duplex byte channel bound to that identity.

It is **not** responsible for:
- Anything above the byte channel: block serialization, message framing, request/response semantics -- those live in `PeerConnection` and the gossip/routing layers.
- Peer selection: who to connect to, when to drop a peer, how many peers to maintain. The [routing](routing.md) and [gossip](gossip.md) layers decide that.
- Signing or validating blocks -- signatures live at the block layer, not the transport layer.

---

## The `TransportPlugin` interface

Every transport implementation is a `TransportPlugin`:

```ts
interface TransportPlugin {
  readonly emitsProtocol?: string;       // protocol this plugin emits signals/addresses for
  readonly acceptsProtocols: string[];   // protocols this plugin consumes
  start(anonymousDriver: AnonymousTransportDriver): TransportService;
}
```

A plugin declares which **signaling protocol** it works with. The `emitsProtocol` and `acceptsProtocols` fields describe how the plugin interprets signals (URLs, SDP offers, socket paths, etc.), not the kind of connection being established.

**Matching rule.** Two peers can negotiate a connection iff one peer's `emitsProtocol` appears in the other peer's `acceptsProtocols`. Examples:

| Plugin               | emits      | accepts      | Role             |
|----------------------|------------|--------------|------------------|
| WebRTC               | `webrtc`   | `['webrtc']` | symmetric        |
| WebSocket server     | `websocket`| `[]`         | listener only    |
| WebSocket client     | -          | `['websocket']` | dialer only   |
| Unix socket          | `unix`     | `['unix']`   | symmetric (local)|

This carves out the client/server asymmetry cleanly: two WebSocket servers don't try to connect to each other because neither accepts `'websocket'`.

---

## Plugin lifecycle

Transport plugins have a three-layer lifecycle:

```
Plugin          (immutable configuration)
  └── Service   (running state: listener, pending handshakes)
        └── Session * (one per authenticated handshake)
```

- **Plugin** is the user-provided entry point. It carries configuration (port, ICE servers, etc.) and declares capabilities. Passed to Scaffold via `ScaffoldConfig.plugins`.
- **Service** is returned from `plugin.start(anonymousDriver)`. It represents the running transport: the open listener, the pending-offer map, active sessions. Lives for the lifetime of the Scaffold node.
- **Session** is created by the service on demand via `initializeAuthenticatedTransport(driver)` -- one per authenticated handshake with a specific remote peer. Single-use: disposed by Scaffold via `close()` after a connection is produced or on timeout.

---

## Connection modes

Each plugin may support one or both of two modes:

### Anonymous mode

Used for **bootstrap connections** and untrusted mesh relay -- the other end's identity is not cryptographically bound to a public key. An anonymous connection is suitable for:
- Initial entry into the network (connecting to a well-known WebSocket server before knowing any peer pubkeys)
- Local testing (Unix sockets between two processes on the same host)
- Relaying signed mesh messages where each message is independently authenticated

The plugin's service drives anonymous mode via two optional methods:

- `announceAddresses()` -- called by Scaffold to ask the plugin to emit one or more reachable addresses by calling `anonymousDriver.broadcastAddress(signal)`. A WebSocket server broadcasts `wss://host:port/`; a Unix socket plugin broadcasts `/tmp/scaffold-abc.sock`.
- `dialAddress(signal)` -- called by Scaffold when a user wants to bootstrap: `scaffold.bootstrapConnection('websocket', 'wss://...')` routes to the plugin whose `acceptsProtocols` contains `'websocket'`, which dials and hands the resulting connection to `anonymousDriver.createAnonymousConnection(conn)`.

### Authenticated mode

Used for **peer-to-peer connections** where both sides have long-term secp256k1 public keys and want mutual identity binding. The handshake runs over Scaffold's encrypted signaling relay: messages are relayed through the mesh of existing connections, encrypted end-to-end via ECDH between the two peers' long-term keys.

Authenticated mode is driven by `initializeAuthenticatedTransport(driver)`. Scaffold hands the plugin a peer-scoped `AuthenticatedTransportDriver`; the plugin:

1. Emits handshake signals via `driver.sendSignal(signal)` (encrypted and mesh-relayed by Scaffold).
2. Receives peer signals via the returned `TransportSession.recvSignal(signal)`.
3. Eventually produces a connection by calling `driver.createAuthenticatedConnection(conn)`.
4. Waits for Scaffold to call `session.close()`.

The plugin is responsible for any transport-specific identity binding:
- **WebRTC** gets mutual identity binding for free via DTLS fingerprint exchange in SDP.
- **WebSocket** plugins typically mint a per-connection random token, deliver it to the client via the encrypted signaling channel, and use it to match incoming connections to sessions. The token is a plugin-internal detail -- Scaffold never sees it.

---

## Signaling envelope

Signals exchanged during an authenticated handshake are wrapped in a `SignalEnvelope`:

```
SignalEnvelope {
    signalingNonce:    hex      // identifies the handshake session
    senderPublicKey:   hex      // secp256k1 compressed
    signalIdx:         uint     // monotonic per sender within a session
    receivedIdxMask:   hex      // bitmask of signals received so far (for ACK)
    encrypted:         base64   // AES-GCM ciphertext of the signal string
    iv:                base64   // AES-GCM IV
}
```

**Crypto:** AES key derived from `HKDF(ECDH(self_priv, remote_pub), nonce)`. Only the two endpoints can decrypt; mesh relays see ciphertext only.

**Retry / ACK:** each side retransmits unacknowledged signals until the ACK mask confirms receipt. Prevents loss during mesh churn.

**Relay:** peers forward signal envelopes toward their addressed recipient through the existing mesh, using the routing layer. Not addressed to self → forward; addressed to self → deliver to local signaling service.

---

## Bootstrap

A new node enters the network by injecting one or more bootstrap addresses:

```ts
await scaffold.bootstrapConnection('websocket', 'wss://seed.scaffold.io:8314/');
```

Scaffold looks up a plugin with `'websocket'` in its `acceptsProtocols`, calls `service.dialAddress(signal)`, and the plugin dials. The resulting connection is anonymous -- no peer identity is bound -- but it's sufficient to participate in mesh relay for signaling, and once an authenticated handshake completes with another peer, the anonymous bootstrap connection can be dropped.

---

## Implementation

| Component | Source |
|-----------|--------|
| Interfaces | [transport.ts](../../src/interfaces/transport.ts) |
| Plugin lifecycle + signal dispatch | [TransportManager.ts](../../src/node/TransportManager.ts) |
| Signaling encryption + relay | [SignalingService.ts](../../src/node/SignalingService.ts) |
| Bridge to protocol stack | [NetworkBridge.ts](../../src/node/NetworkBridge.ts) |
| Byte-level peer wire | [PeerConnection.ts](../../src/node/PeerConnection.ts) |
| Unix socket plugin | [UnixSocketTransport.ts](../../src/node/UnixSocketTransport.ts) |
| WebSocket client plugin | [WebsocketClientTransport.ts](../../plugins/WebsocketClientTransport.ts) |
| WebSocket server plugin | [WebsocketServerTransport.ts](../../plugins/deno/WebsocketServerTransport.ts) |
| WebRTC plugin | [WebrtcTransport.ts](../../plugins/browser/WebrtcTransport.ts) |

---

## Invariants

1. **Identity is peer-scoped at the driver level.** When Scaffold hands a plugin an `AuthenticatedTransportDriver`, the driver is already bound to a specific remote pubkey. The plugin never has to tell Scaffold who a connection is with -- that's implicit in which driver the plugin called `createAuthenticatedConnection` on.
2. **Sessions are single-use.** A `TransportSession` handles exactly one authenticated handshake. Scaffold calls `session.close()` after the connection is produced or on timeout. Long-lived state (listeners, pending-token maps) lives in the `TransportService`.
3. **Tokens are plugin-private.** Any per-connection tokens used to match inbound bytes to sessions are implementation details of the plugin. They never appear in `TransportPlugin` or driver interfaces.
4. **Anonymous ≠ insecure.** Anonymous connections are suitable for carrying signed, independently-authenticated messages. They are not suitable for carrying traffic that assumes cryptographic identity binding.

---

## Out of scope

- **Mesh-level address gossip:** addresses emitted via `broadcastAddress` currently surface only to the local node. Propagating them through the mesh as signed reachability announcements is future work.
- **Transport negotiation across peers:** when multiple transports could connect two peers (e.g. both WebRTC and WebSocket), the runtime currently tries an arbitrary match. A capability-announcement protocol is future work.
- **In-band channel-bound authentication:** authenticated connections trust TLS (for WSS) and DTLS (for WebRTC) at the transport layer. Stronger-than-TLS P2P authentication via in-band SIGMA is future work; see the design thread in the plan archive.
