# Two-Browser Chess Demo — Plan

Tasks C (modernize `scripts/signalingServer.ts`) and D (wire transports into `ChessApp.tsx`). Goal: two browsers on the same machine run the chess demo against each other end-to-end.

## Architecture

- Two browser tabs each run a `Scaffold` with `[WebsocketClientTransport, WebrtcTransport]`.
- One Deno process runs a `Scaffold` with `[WebsocketServerTransport]` as a rendezvous hub.
- Both browsers dial the hub via `scaffold.bootstrapConnection('websocket', 'ws://127.0.0.1:8314/')`. The hub's only job is to mesh-relay encrypted signaling messages between the browsers so they can complete the WebRTC handshake. It is not a block relay that stores game state, though `NetworkBridge` will gossip blocks through it too — fine for a local demo.
- Once both browsers know each other's pubkey, either side calls `scaffold.connectToPeer(remotePubkey)` which initiates an authenticated handshake via WebRTC.

Nothing in the protocol requires the hub to be special. It's just a reachable `websocket@server` node.

## Identity and genesis

Currently `ChessApp.tsx:31-45` generates a fresh random private key and a one-output genesis per tab. For two tabs to see each other's blocks we need (a) the same genesis and (b) identities reachable by pubkey.

Proposed: reuse `computeDemoGenesis(['a','b','c'])` and `demoPrivateKey(seed)` from `src/genesis.ts` (already used by `scripts/demo_node.ts:37-41, 85`). The genesis pre-funds 1 000 000 per seed to three well-known pubkeys. A browser picks its seed from a URL hash param: `#chess?seed=a`, `#chess?seed=b`, `#chess?seed=c`. Fall back to seed `a` if none given. This keeps demo identities predictable and avoids a localStorage dance for v1.

Peer-list UX: after bootstrap, each browser learns the hub's pubkey via `onPeerConnected`. The other browser's pubkey is not automatically exchanged by the hub — we need a way to discover it. Simplest options:

1. **Hard-code the seed→pubkey map in the UI** (same data `demo_node.ts` emits under `knownPeers`). Show a "Connect to seed b" button in the header; clicking it runs `scaffold.connectToPeer(demoPublicKey('b'))`. Zero discovery logic needed.
2. Auto-connect: on `onPeerConnected(hubPeerId)`, loop over the known seeds and call `connectToPeer` for each one that isn't us. Handshakes to offline seeds fail quietly (transport timeout); the ones that succeed just work.

I recommend (2) because it's hands-off for the demo. `connectToPeer` to an unreachable peer currently has no retry — if seed `b` isn't live yet when seed `a` boots, `a`'s call fails silently. Mitigate by calling `connectToPeer` on every `onPeerConnected` event too, so when `b` later joins the hub and `a` sees `b`'s hub-peer-connected event, `a` retries.

Risk: `connectToPeer` calls might race against the hub signaling path before it's warm. Acceptable for the demo; if unreliable we'll add a retry-on-disconnect loop.

## Task C: `scripts/signalingServer.ts`

Current file uses `Context`, `makeDefaultConfig`, `WebsocketServerProvider`, `NetworkService` — none of those exist anymore. Throw it out and rewrite:

```ts
#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from '@std/cli/parse-args';
import { Scaffold } from '../src/Scaffold.ts';
import {
  computeDemoGenesis,
  demoPrivateKey,
  demoPublicKey,
} from '../src/genesis.ts';
import { WebsocketServerTransport } from '../plugins/deno/WebsocketServerTransport.ts';
import { bin2hex } from '../src/util/hex.ts';

const flags = parseArgs(Deno.args, { string: ['port'] });
const port = flags.port ? Number(flags.port) : 8314;

const DEMO_SEEDS = ['a', 'b', 'c'] as const;
const HUB_SEED = 'hub';

const scaffold = new Scaffold({
  privateKey: demoPrivateKey(HUB_SEED),
  genesis: computeDemoGenesis(DEMO_SEEDS),
  plugins: [new WebsocketServerTransport({ port })],
  enableLogging: false,
});

scaffold.onPeerConnected((peerId) => {
  console.log(`peer_connected ${peerId}`);
});
scaffold.onPeerDisconnected((peerId) => {
  console.log(`peer_disconnected ${peerId}`);
});

scaffold.start();
console.log(`signaling hub listening ws://127.0.0.1:${port}/`);
console.log(`hub pubkey: ${bin2hex(demoPublicKey(HUB_SEED))}`);
```

Notes:
- Hub gets its own seed so it doesn't share a signature UTXO with a browser seed.
- `enableLogging: false` keeps stdout quiet; the `console.log` lines are explicit demo UX.
- No stdin command loop; the hub just runs. This is intentionally simpler than `demo_node.ts`.

Verification: run `deno run --allow-all scripts/signalingServer.ts`, see it log the listening message, kill with Ctrl-C.

## Task D: wire transports into `ChessApp.tsx`

Changes to `demo/src/chess/ChessApp.tsx`:

1. **Replace the `useMemo` scaffold construction** (lines 31-45). Parse `?seed=X` out of `window.location.hash`, resolve to `demoPrivateKey(seed)` + `computeDemoGenesis(['a','b','c'])`, and pass `plugins: [new WebsocketClientTransport(), new WebrtcTransport()]`. Call `scaffold.start()` (NodeContext doesn't auto-start transports). Call `scaffold.bootstrapConnection('websocket', 'ws://127.0.0.1:8314/')`. Call `scaffold.close()` on unmount (the useMemo cleanup already runs on remount).

2. **Auto-dial peers** (new useEffect):
   - On mount: attempt `connectToPeer` to each other demo seed.
   - On every `onPeerConnected`: for each demo seed that we're not already connected to, attempt `connectToPeer` again. Dedupe to avoid re-initiating on our own pubkey.
   - Track connection status in local state for a small header UI.

3. **Header chrome.** Above the existing `leftPaneStyle` pane, add a one-row status bar: "You are seed A (pubkey 03ab...) — connected peers: B, hub". Helps operators sanity-check the demo is wired. Keep it minimal: dark pill per peer showing seed letter + short pubkey.

4. **Dev-mode route hint.** `main.ts` or `App.tsx` currently routes to `#chess`. Teach the router that `#chess?seed=X` stays on the chess page with that seed. Two ways: parse the query-part of the hash and ignore it in the route match, or use a custom hashchange listener. Smallest change: treat anything starting with `#chess` as chess.

5. **No localStorage in v1.** Identity is purely seed-driven. If we later want per-user tabs beyond three seeds, add a generate-and-persist-random-key toggle.

## Known limitations in v1

- Three fixed seeds means only three participants at once. To go beyond that we need real identity persistence and a lobby view; out of scope here.
- If a browser refreshes, its WebRTC peer connection drops; the other side sees `onPeerDisconnected` and the auto-dial on reconnect restores it. Not tested.
- No TURN server. Same machine is fine; cross-network may fail (acceptable for a local demo).
- No merge freeze on block conflict — if both browsers simultaneously try to create a game with the same parameters we'll get conflicting blocks. Unlikely in normal use.

## Work order

1. Write `scripts/signalingServer.ts` (Task C). Verify it starts and logs.
2. Extend `ChessApp.tsx` with plugins, bootstrap, auto-dial (Task D). Smoke test: open two tabs at `#chess?seed=a` and `#chess?seed=b`, watch them establish a WebRTC connection via the hub.
3. Manual E2E: seed A creates a game, seed B joins, make a few moves on A. Expect one move to land (turn=0 join, turn=1 is blocked by the pre-existing chess-turn-one-bug — documented in [`chess-turn-one-bug.md`](chess-turn-one-bug.md)).
4. If the UI works up to but not past turn=1, we've validated the transport wiring independently of the remaining known bug. If it fails earlier, root-cause before fixing turn=1.

## Files touched

New:
- `docs/design/chess-two-browser-demo.md` (this file)

Rewritten:
- `scripts/signalingServer.ts`

Modified:
- `demo/src/chess/ChessApp.tsx`
- `demo/src/App.tsx` (only if `#chess?seed=X` routing needs a tweak — verify first)

Unchanged:
- All of `src/` — no protocol changes needed.
- `plugins/*` — reuse as-is.
