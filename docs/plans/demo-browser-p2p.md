# Demo: Browser-to-Browser Direct (WebRTC)

## Overview

Two browsers exchange blocks directly via WebRTC with no relay server. This makes the "browser-native" vision visceral -- the audience sees there's no backend, just browsers talking to browsers. The signaling server is minimal (or eliminated entirely with manual SDP exchange for dramatic effect).

## What Already Works

### WebRTC Plugin
`plugins/browser/WebrtcProvider.ts`:
- Dynamic STUN server fetching
- Two data channels: reliable (ordered) and fast (unordered)
- ICE candidate gathering
- Offer/answer SDP exchange
- Connection state detection
- Buffered packet delivery on channel open

### WebSocket Plugin
`plugins/WebsocketClientProvider.ts`:
- Full client implementation
- Binary frame handling
- Single-connection deduplication

### Network Manager
`src/node/NetworkManager.ts`:
- Plugin interface: `start()`, `bootstrap()`, `sendBlock()`
- Manages multiple plugins simultaneously
- Peer connection lifecycle

### Scaffold
- Full protocol stack running in browser (Vite + React demo exists)
- `demo/App.tsx` creates real Scaffold instances

### Wire Format
`src/core/Packet.ts`:
- Binary serialization/deserialization
- Compact encoding for all block fields
- Signature embedding

## What Needs Building

### 1. Signaling Server

WebRTC requires an out-of-band signaling channel for the initial SDP offer/answer exchange. Options:

**Option A: Minimal WebSocket signaling server** (recommended for demo)
- Tiny Deno server (~50 lines): accepts WebSocket connections, relays SDP offers/answers between peers
- Peers connect to signaling server only for initial handshake
- After WebRTC connection established, signaling server is no longer needed
- Can literally shut down the signaling server mid-demo to prove it

**Option B: Manual SDP copy-paste** (dramatic but awkward)
- Browser A generates SDP offer, displays as QR code or text
- Operator copies to Browser B
- Browser B generates answer, copies back
- Proves "no server" but is clunky

**Option C: QR code signaling** (best of both worlds)
- Browser A generates offer, displays as QR code
- Browser B scans QR code with webcam, generates answer as QR code
- Browser A scans answer QR code
- Very visual, no server at all, but requires camera permissions

Recommendation: **Option A for reliability, show Option C as the "look, no server at all" moment if time permits.**

### 2. Wire NetworkManager into Scaffold

The gap between existing code:

```
Current:   Scaffold → NodeContext → ReactiveLayer → strategies
                                                      ↕
Missing:                                    NetworkManager → plugins
```

Need to wire:
- **Inbound**: `NetworkManager.onBlockReceived` → `coordinator.blockReceived()`
- **Outbound**: Gossip push actions → `NetworkManager.sendBlock(target)`
- **Lifecycle**: Plugin connection events → `gossipModule.addPeer()` / `removePeer()`

This is the adapter layer described in TODO.md under "Wire Up Network Plugins."

### 3. Browser Scaffold Instance

Enhance `demo/App.tsx` (or create new page) to:
- Create a `Scaffold` instance with WebRTC plugin
- Connect to signaling server for peer discovery
- Display connection state (searching → connecting → connected)
- Show peer info (their public key, latency)
- Create and receive blocks in real-time

### 4. Latency Display

Key selling point: WebRTC peer-to-peer is faster than client-server.

Show:
- Time from block creation to receipt on other browser
- Compare to typical REST API latency (~50-200ms)
- WebRTC data channel latency is typically 10-50ms on same network

### 5. Connection Visualization

Show the WebRTC connection state:
- ICE gathering (finding network paths)
- STUN server contact (NAT traversal)
- Connection established (direct P2P link)
- Data flowing (blocks as animated packets)

## Architecture

```
┌─────────────────┐           ┌─────────────────┐
│  Browser A       │           │  Browser B       │
│                  │           │                  │
│  Scaffold        │  WebRTC   │  Scaffold        │
│  ├─ Consensus    │◄────────►│  ├─ Consensus    │
│  ├─ BlockCreation│  (direct) │  ├─ BlockCreation│
│  ├─ Gossip       │           │  ├─ Gossip       │
│  └─ ...          │           │  └─ ...          │
│                  │           │                  │
│  WebrtcProvider  │           │  WebrtcProvider  │
│  └─ DataChannel  │           │  └─ DataChannel  │
└────────┬────────┘           └────────┬────────┘
         │                              │
         │  SDP offer/answer            │
         └──────────┬───────────────────┘
                    │
           ┌────────────────┐
           │ Signaling Server│  (temporary, can be
           │ (WebSocket)     │   shut down after
           └────────────────┘   connection)
```

## Implementation Steps

### Step 1: Signaling server
- New file: `src/demo/signaling-server.ts`
- Accepts WebSocket connections with a `peerId` parameter
- Relays messages between peers: `{ type: "offer"|"answer"|"ice-candidate", to: peerId, data: ... }`
- No authentication, no persistence -- pure relay
- `deno task demo:signaling` run script

### Step 2: Wire NetworkManager adapters
- New file: `src/node/NetworkAdapter.ts`
- Connects `NetworkManager` events to `Coordinator` and `GossipModule`
- Inbound: deserialize packet → `coordinator.blockReceived()`
- Outbound: gossip actions → serialize → `networkManager.sendBlock()`
- Peer lifecycle: plugin connect/disconnect → gossip add/remove peer

### Step 3: Browser Scaffold with WebRTC
- Update `demo/App.tsx` or create `demo/src/P2PDemo.tsx`
- Initialize Scaffold with WebrtcProvider
- Connect to signaling server
- Display connection state and peer info
- Block creation UI (simple form: enter data, click "Create Block")

### Step 4: Block exchange demo
- Browser A creates a block (button click)
- Block appears in Browser A's local view
- Block propagates via WebRTC data channel to Browser B
- Block appears in Browser B's view
- Measure and display propagation latency

### Step 5: Signaling server shutdown demo
- After WebRTC connection is established, stop the signaling server
- Show that blocks still propagate -- the browsers are talking directly
- "The server was just for introductions. Now it's gone."

### Step 6: Multi-browser scaling
- Add support for 3+ browsers
- Each browser connects to all others via WebRTC (mesh topology)
- Show gossip: block created on Browser A reaches Browser C via Browser B

### Step 7: Polish
- Connection state animations (pulsing dots, connection lines)
- Latency histogram
- Block count per peer
- Network topology view (which browsers are connected to which)

## Stretch Goals

### QR Code Signaling
- Use a QR code library to encode SDP offers as QR codes
- Browser A displays QR, Browser B scans it
- Eliminates the signaling server entirely
- Very visual for live demos

### Cross-Network Demo
- Two browsers on different WiFi networks
- STUN/TURN traversal required
- Shows it works over the real internet, not just localhost

### Mobile Browser
- Open Scaffold in a mobile browser
- Connect to desktop browser via WebRTC
- Shows true browser-native -- even works on phones

## Effort Estimate

- Signaling server: ~0.5 day
- NetworkManager adapters: ~1.5 days (main integration work)
- Browser Scaffold with WebRTC: ~1.5 days
- Block exchange demo: ~0.5 day
- Signaling shutdown demo: ~0.5 day
- Multi-browser: ~0.5 day
- Polish: ~1 day
- **Total: ~6 days**

## Dependencies

- `WebrtcProvider` has one known TODO (initiator ordering) -- needs fix but is minor
- `NetworkManager` plugin interface is defined but the adapter to coordinator/gossip doesn't exist yet
- Browser build setup (Vite) exists in `demo/` but may need updates for new imports
- STUN servers must be accessible (uses public Google STUN by default, fetches from GitHub)

## Risk

Medium-high. Three integration points that haven't been tested together:
1. WebrtcProvider → NetworkManager (plugin interface exists, but never used with WebRTC in prod)
2. NetworkManager → Coordinator (adapter doesn't exist yet)
3. Scaffold running in browser with full protocol stack + network

Mitigation: Test each integration point incrementally:
1. First: two Scaffold instances in same browser tab with MockNetworkProvider → verify blocks propagate
2. Second: two browser tabs with WebSocket (simpler than WebRTC) → verify cross-tab block exchange
3. Third: two browser tabs with WebRTC → verify full P2P

If WebRTC proves problematic (NAT issues, ICE failures), fall back to WebSocket between browsers and a lightweight relay. Still demonstrates browser-to-browser, just with a relay in the middle. The relay can be shown to do zero processing ("it just forwards bytes").
