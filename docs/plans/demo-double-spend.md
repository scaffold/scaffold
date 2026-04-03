# Demo: Double-Spend Race

## Overview

Demonstrate the fundamental value proposition of decentralized consensus: two conflicting transactions for the same funds, detected and resolved by the protocol without any central authority. This is the "aha moment" demo -- the audience sees the problem and the solution in real-time.

## What Already Works

- **ConsensusModule**: Three-rule canonicality (anchor, aggregation, conflict). Effective weight = own weight + descendant weight. Deterministic tie-breaking by hash.
- **OutputClaimModule**: Claim migration, conflict detection when two blocks claim the same output. Reports conflicts to consensus.
- **BlockCreationModule**: Throughput balancing (inputs == outputs). Validates claim indices against extended output vector.
- **Scaffold.autoBalance()**: Automatically selects UTXOs and adds change outputs to balance value.
- **DemoNode**: Full packet validation, peer sync, tip selection.
- **DemoGenesis**: Genesis with 10 animal identities, each with status outputs. Can also be configured with signature outputs holding coin value.

## The Scenario

### Setup
- **Alice** has 1000 coins (a signature output in genesis spendable by Alice's key)
- **Bob** and **Charlie** are recipients
- Two nodes: Node A (Alice + Bob) and Node B (Alice + Charlie)

### The Attack
1. Alice on Node A creates a block: "Pay 1000 to Bob" (claims Alice's output, creates Bob's output)
2. Alice on Node B creates a block: "Pay 1000 to Charlie" (claims the SAME output, creates Charlie's output)
3. Both blocks are valid individually -- each correctly spends Alice's coins

### The Resolution
4. Both blocks propagate to an observer node
5. Observer detects the conflict: two blocks claim the same output
6. Consensus resolves by effective weight
7. The losing payment becomes non-canonical -- those coins are "unspent" from the loser's perspective
8. Network converges: all nodes agree on which payment succeeded

## What Needs Building

### 1. Value-Based Genesis

Extend `DemoGenesis` (or create a parallel genesis) with signature outputs holding coin value:
- Alice: 1000 coins (signature output, spendable by Alice's key)
- Bob: 0 coins initially
- Charlie: 0 coins initially

This is straightforward -- `makeSignatureOutput(publicKey, value)` already exists.

### 2. Payment Block Construction

A helper that creates a "payment" block:
- Claims Alice's output (the 1000 coins)
- Creates a new output: `makeSignatureOutput(recipientPubkey, amount)`
- Creates change output if needed: `makeSignatureOutput(alicePubkey, change)`
- Anchors to the current canonical tip
- Signs with Alice's key

`Scaffold.put()` with `autoBalance()` handles most of this. The missing piece is targeting a specific recipient (currently the demo only does status messages).

### 3. Coordinated Timing

The conflict must happen simultaneously (or near-simultaneously). If one payment propagates before the other is created, the second node will see the first and refuse to create a conflicting block (or the conflict will be immediately resolved).

Options:
- **Network partition**: Disconnect the two nodes, create both payments, then reconnect. Most realistic.
- **Scripted delay**: Create both blocks locally before connecting either to the observer.
- **Race condition**: Just do it fast. In practice, with WebSocket latency, there's a window.

Recommendation: **Network partition** -- it's the most realistic and the most dramatic. "Alice disconnects from the network, pays Bob. Meanwhile, on another machine, Alice pays Charlie. Now we reconnect..."

### 4. Visualization

This demo works best when combined with the block graph viz (demo-block-graph-viz.md). Show:
- Genesis with Alice's 1000-coin output highlighted
- Two blocks appear (one green, one yellow -- "contested")
- Conflict edge between them (red dashed line)
- As more blocks are created on one side, weight accumulates
- The losing block turns gray
- Alice's balance shows: 0 (spent). Bob's shows: 1000 (or Charlie's, depending on who won).

If the viz isn't ready, a simpler text-based display works:
```
Alice: 1000 → 0 (spent)
Bob:      0 → 1000 ✓ (canonical)
Charlie:  0 → 1000 ✗ (non-canonical, conflict lost)
```

### 5. Balance Tracker

A small UI component (or CLI output) showing current balances:
- Query `UtxoIndex` for each identity's signature outputs
- Sum canonical output values
- Update in real-time as canonicality changes

## Implementation Steps

### Step 1: Payment helper
- New file: `src/demo/PaymentHelper.ts`
- `createPayment(scaffold, fromIdentity, toPublicKey, amount)` -- builds and submits a payment block
- Uses `autoBalance()` for change outputs
- Returns the created block hash

### Step 2: Balance display
- Extend `StatusIndex` or create `BalanceIndex` that tracks signature output values
- Subscribe to canonicality changes via `UtxoIndex`
- Display format: `identity: balance` for each participant

### Step 3: Double-spend scenario script
- New file: `src/demo/double-spend-scenario.ts`
- Creates 3 nodes: Alice-Bob, Alice-Charlie, Observer
- Phase 1: Connect all, sync genesis
- Phase 2: Disconnect Alice-Bob from Alice-Charlie (partition)
- Phase 3: Alice-Bob pays Bob 1000. Alice-Charlie pays Charlie 1000.
- Phase 4: Reconnect. Observer receives both blocks.
- Phase 5: Wait for resolution. Display winner.

### Step 4: Integration with viz (optional)
- If block graph viz is ready, feed events from the scenario into it
- Highlight the conflicting blocks and resolution

### Step 5: Polish
- Add narration/logging that explains each step as it happens
- Add a delay between phases so the audience can follow
- `deno task demo:double-spend` run script

## Demo Script (Presentation)

1. "Alice has 1000 coins. She's going to try to spend them twice."
2. Show 3 terminals (or the viz). All connected, synced on genesis. Balance display: Alice=1000, Bob=0, Charlie=0.
3. "First, Alice disconnects from part of the network." Partition the network.
4. "On this side, Alice pays Bob." Create the payment. Bob's balance shows 1000 on Node A.
5. "But on the other side, Alice pays Charlie." Create the payment. Charlie's balance shows 1000 on Node B.
6. "Both payments look valid. Both nodes think they have the correct state. Now we reconnect."
7. Reconnect. Pause.
8. "The protocol detected the conflict. Two blocks both claim Alice's 1000 coins."
9. "It resolves by weight -- whichever payment has more cumulative work behind it wins."
10. One payment goes gray. The winning recipient keeps 1000. The loser goes back to 0.
11. "No coordinator decided this. No vote. The math resolved it."
12. "And Alice? She still has 0. You can't double-spend on Scaffold."

## Effort Estimate

- Payment helper: ~0.5 day
- Balance display: ~0.5 day
- Scenario script: ~1 day
- Viz integration: ~0.5 day (if viz exists)
- Polish: ~0.5 day
- **Total: ~2-3 days**

## Dependencies

- Works standalone with terminal output
- Better with demo-block-graph-viz (but not required)
- Uses same infrastructure as demo-status-feed (DemoNode, Transport, Identity)

## Risk

Low. All conflict detection and resolution is implemented and tested. The main risk is timing -- if the partition isn't clean, one payment might propagate before the other is created, which makes the demo less dramatic (though the protocol still resolves correctly).
