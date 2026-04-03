# Demo: Multi-Node Status Feed

## Overview

Polish the existing `src/demo/` P2P demo into a presentable "decentralized social feed" -- multiple terminal nodes publishing status updates, with real-time propagation and conflict resolution visible to the audience.

## What Already Works

The entire backend is functional:
- `DemoNode.ts`: Full node with packet validation, status publishing, peer sync
- `Identity.ts`: 10 deterministic animal identities (antelope through jackal)
- `StatusContract.ts`: Encode/decode status messages (33-byte pubkey + UTF-8)
- `StatusIndex.ts`: UTXO-based status tracking with subscription notifications
- `Transport.ts`: WebSocket server/client for peer connections
- `ContractValidator.ts`: Signature verification for status claims
- `DemoGenesis.ts`: Shared genesis with initial status outputs for all animals
- `main.ts`: CLI with connect/pub/sub/status commands, JSONL event output

## What Needs Building

### 1. Terminal UI (TUI) Frontend

Replace raw JSONL output with a readable terminal interface showing:
- **Status feed panel**: Latest status for each animal, updated in real-time
- **Network panel**: Connected peers and their identities
- **Event log**: Recent block events (created, received, conflict detected, conflict resolved)
- **Input bar**: Commands at the bottom

Options:
- **Ink (React for CLI)**: Familiar React model, renders to terminal. Good fit since we already use React in `demo/`.
- **Raw ANSI**: Simpler, no dependency. Write a small renderer that clears and redraws on events.
- **Web UI**: Small HTTP server + SSE stream from the DemoNode events. Opens in browser. Most visually impressive but more work.

Recommendation: **Web UI** -- it's the most demo-friendly (can be shown on a projector), and the event stream from `main.ts` is already JSONL which maps directly to SSE.

### 2. Conflict Scenario Script

A scripted scenario that demonstrates conflict resolution:
1. Two nodes both hold the same animal identity (e.g., both claim "antelope")
2. Both publish different status messages for "antelope" simultaneously
3. Both blocks propagate to a third observer node
4. The observer detects the conflict (two claims on the same output)
5. Consensus resolves by weight -- the block with higher effective weight wins
6. The losing status disappears from all nodes' feeds

This requires:
- A way to run the scenario without manual timing (a script that coordinates the two publishers)
- Visual indication of conflict state: show both statuses briefly, then resolve to one
- Log entries explaining what happened ("Conflict detected: antelope claimed by node A and node B", "Resolved: node A wins by weight")

### 3. Observer Mode

A read-only node that connects to all publishers and displays the network state. This is the "audience view" -- projected on screen while the operator runs commands on the publisher nodes.

The observer:
- Connects to all other nodes
- Shows all statuses in real-time
- Highlights conflicts as they appear and resolve
- Shows block count, tip depth, peer count

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Node A       │◄──►│  Node B       │◄──►│  Observer     │
│  (antelope,   │    │  (fox,        │    │  (read-only)  │
│   bear, cat)  │    │  gorilla)     │    │               │
└──────┬───────┘    └──────┬───────┘    └───────────────┘
       │                    │
       └────────────────────┘
       WebSocket connections
```

Each node runs `main.ts` on a different port. Observer connects to both.

## Implementation Steps

### Step 1: Web-based status viewer
- Add a small HTTP handler to `main.ts` (or a new `demo-ui.ts`)
- Serve a single HTML page with embedded JS
- SSE endpoint streams DemoNode events
- Page renders: status grid, peer list, event log
- Style it minimally but cleanly (dark theme, monospace, color-coded statuses)

### Step 2: Conflict demo script
- New file: `src/demo/conflict-scenario.ts`
- Spawns 3 nodes (two publishers, one observer)
- Auto-connects them in a triangle
- Waits for sync, then simultaneously publishes conflicting statuses
- Logs the conflict detection and resolution timeline

### Step 3: Polish and rehearse
- Add startup banner showing node identity and port
- Add `--observer` flag that disables publishing, shows all statuses
- Test with different timing (simultaneous, staggered, rapid succession)
- Write a run script: `deno task demo:status`

## Demo Script (Presentation)

1. "This is a decentralized status network. No server. Each node is a peer."
2. Start 3 terminals. Each shows a different node with different animal identities.
3. Publish a status from Node A: `pub antelope "Hello from antelope!"`
4. Watch it appear on Node B and Observer within ~100ms.
5. Publish from Node B: `pub fox "Fox says hi"`
6. "Now watch what happens when two nodes disagree..."
7. Run conflict scenario. Both nodes publish different statuses for the same identity.
8. Observer shows both briefly, then one disappears.
9. "The protocol detected the double-spend and resolved it by weight. The losing update is gone -- not just hidden, but economically penalized."

## Effort Estimate

- Web viewer: ~1 day (HTML/JS page + SSE endpoint)
- Conflict script: ~0.5 day
- Polish: ~0.5 day
- **Total: ~2 days**

## Risk

Low. All protocol mechanics are implemented and tested. This is purely presentation layer.
