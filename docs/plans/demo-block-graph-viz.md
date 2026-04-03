# Demo: Live Block Graph Visualization

## Overview

Build a real-time block graph visualization that shows the DAG growing as nodes create blocks, with color-coded canonicality, conflict highlighting, and weight flow. This serves as the "stage" for other demos -- it runs the whole time and makes the abstract protocol tangible.

## What Already Works

### viz/ directory (standalone simulation)
- `SimEngine.ts`: Multi-node simulation with gossip, weight-gated forwarding
- `DagRenderer.ts`: Graphviz-based DAG rendering (uses `@viz-js/viz`)
- `NetworkRenderer.ts`: Canvas-based network topology with animated in-flight messages
- `main.ts`: Animation loop, tick-based simulation
- Fully functional -- runs in browser, shows blocks appearing, gossip propagation

### demo/ directory (React app)
- `App.tsx`: Imports `BlockGraphExplorer` from `@scaffold/explorer`
- Creates real `Scaffold` instances with strategy selection
- Block creation via `scaffold.put()`
- Vite + React setup

### Core protocol
- `ConsensusModule`: Emits canonicality changes with full conflict info
- `ReactiveLayer`: Evaluates strategies on every block, produces actions
- `Coordinator`: Routes blocks through all modules, fires listeners

## What Needs Building

### 1. Connect Viz to Real Protocol State

The `viz/` simulation currently uses its own simplified block model (`BlockInfo` in `types.ts`). It needs to read from actual `Scaffold` instances instead.

Two approaches:

**Option A: Embed Scaffold in viz** (recommended)
- Replace `SimEngine` internals with real `Scaffold` instances per node
- Each simulated node is a `Scaffold` with in-memory transport
- DAG renderer reads from `block.store` instead of the simplified model
- Canonicality comes from `consensus.isCanonical()` instead of manual tracking

**Option B: Event bridge from running nodes**
- Running DemoNodes emit block events via WebSocket/SSE
- Viz connects as a client and builds the graph from events
- More realistic (shows actual network behavior) but more plumbing

Recommendation: **Option A for the core viz, Option B as a stretch goal.** Option A gives us a self-contained browser demo that doesn't need running Deno nodes.

### 2. Enhanced DAG Rendering

Current `DagRenderer` uses basic graphviz. Enhance with:

- **Canonicality coloring**: Green for canonical, red/gray for non-canonical, yellow for contested
- **Conflict edges**: Dashed red lines between conflicting blocks
- **Weight labels**: Show declaredWeight and effective weight on each node
- **Aggregation grouping**: Visual clusters for aggregation trees
- **Animation**: Smooth transitions when new blocks appear (fade in) and when canonicality changes (color transition)
- **Block tooltips**: Hover to see full block details (hash, anchor, claims, outputs)

### 3. Network Topology View

The existing `NetworkRenderer` already does this well. Enhance with:
- **Node labels**: Show which animal identities each node holds
- **Message type coloring**: Different colors for block propagation vs. gossip metadata
- **Latency indicators**: Show simulated/real latency between peers
- **Bandwidth bars**: Visual indicator of gossip bandwidth allocation per peer

### 4. Control Panel

Interactive controls for the demo operator:
- **Speed**: Slow down/speed up the simulation (or pause)
- **Create block**: Button to trigger block creation on a specific node
- **Create conflict**: Button to trigger simultaneous conflicting blocks
- **Toggle strategies**: Enable/disable sampling, dispute, generation per node
- **Node count**: Add/remove nodes dynamically
- **Inject fault**: Simulate network partition (disable edges), invalid blocks

### 5. Event Timeline

A scrolling log at the bottom showing protocol events in real-time:
- "Block abc123 created by Node 1 (weight: 5)"
- "Conflict detected: abc123 vs def456 both claim output 0 of genesis"
- "Resolved: abc123 wins (effective weight 15 > 10)"
- "Probe started on tree rooted at abc123"
- "Verification complete: block abc123 valid (weight factor: 0.8)"

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser                                         │
│  ┌───────────────┐  ┌────────────────────────┐  │
│  │ Control Panel  │  │  DAG View (graphviz)   │  │
│  │ [Create Block] │  │  ┌──┐ ──► ┌──┐        │  │
│  │ [Add Conflict] │  │  │G │     │B1│──►┌──┐ │  │
│  │ [Partition]    │  │  └──┘ ──► │  │   │B3│ │  │
│  │ Speed: [===]   │  │          └──┘   └──┘  │  │
│  └───────────────┘  └────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │ Network Topology    │  Event Timeline      │  │
│  │  N1 ──── N2         │  12:00:01 Block...   │  │
│  │  │  \  / │          │  12:00:02 Conflict...│  │
│  │  N3 ──── N4         │  12:00:03 Resolved...│  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  [Scaffold x4]  ◄──► MockNetworkProvider         │
└─────────────────────────────────────────────────┘
```

Each node is a full `Scaffold` instance with `MockNetworkProvider` for in-memory transport.

## Implementation Steps

### Step 1: Multi-Scaffold browser harness
- Create `viz/ScaffoldSim.ts`: manages N Scaffold instances with mock transport
- Wire block events: when one node creates a block, deliver to peers via mock network
- Expose event stream for rendering

### Step 2: Upgrade DAG renderer
- Add canonicality state to node coloring (query consensus module)
- Add conflict edges (query output claim module)
- Add weight labels
- Smooth transitions via CSS/canvas animation

### Step 3: Control panel
- React or vanilla JS controls
- Wire buttons to ScaffoldSim methods
- Speed control via tick interval adjustment

### Step 4: Event timeline
- Collect events from all nodes' coordinators and consensus modules
- Render as scrolling log with timestamps and color coding
- Filter by event type

### Step 5: Polish
- Dark theme, clean layout
- Responsive sizing
- Keyboard shortcuts for common actions (space = pause, c = create block, x = create conflict)

## Demo Script (Presentation)

1. Open the viz in a browser. 4 nodes visible in the network view. Genesis block in the DAG.
2. "Each node is a full Scaffold instance running in your browser."
3. Click "Create Block" on Node 1. Watch the block appear in the DAG, then propagate across the network (messages animate between nodes).
4. Create a few more blocks. The DAG grows. Anchor chain forms.
5. "Now watch what happens with a conflict." Click "Create Conflict."
6. Two blocks appear, both claiming the same output. Red conflict edge appears.
7. More blocks are created. One side gets more weight. The losing block turns gray.
8. "Consensus resolved by weight. No coordinator. No voting. Just math."
9. Click "Partition" -- split the network in two. Each half keeps building independently.
10. Remove partition. Watch the two chains merge and conflicts resolve.

## Effort Estimate

- Multi-Scaffold harness: ~1.5 days
- DAG renderer upgrade: ~1.5 days
- Control panel + event timeline: ~1 day
- Polish: ~1 day
- **Total: ~5 days**

## Risk

Medium. The viz/ code works but uses a simplified model. Bridging to real Scaffold instances may reveal rendering performance issues with large graphs. Graphviz layout can be slow for 50+ blocks -- may need to cap visible blocks or switch to a force-directed layout.
