# Routing Module

The routing module delivers blocks to the peers who need them. It takes **send actions** from the [gossip protocol](gossip.md) and maps them to specific peers, managing bandwidth, topology learning, and delivery efficiency.

This module is the "how to send" layer. The gossip protocol determines which blocks match which subscriptions; this module determines which peer receives each block, when, and at what priority.

This module is responsible for:
- Maintaining per-peer state (receivedFirst, delivery matrix, reciprocity, bandwidth)
- Mapping send action triggers to target peers
- Computing final push priority (incorporating delivery probability and block size)
- Managing push queues and bandwidth allocation
- Block awareness exchange and inventory tracking
- Providing a block fetch interface for other modules
- Baseline propagation for blocks with no subscription match

This module is **not** responsible for:
- Determining which blocks are relevant to which subscriptions (gossip protocol)
- Peer discovery or connection management (PeerModule)
- Block validation or verification (verification module)

---

## Peer State

For each connected peer P, the module maintains:

```
PeerState {
    receivedFirst:     Set<Hash>                     // blocks P sent us first
    knownBlocks:       BlockAwareness                // compact representation of P's inventory
    deliveryMatrix:    Map<PeerID | Self, Beta>       // first-delivery rates by source
    reciprocity:       Number                         // utility balance (decayed)
    bandwidthBudget:   Number                         // bytes/sec allocated to this peer
    responseIndex:     Map<Verifier, Number>           // per-verifier push counter
}
```

### Received-First Set

`receivedFirst` tracks blocks where P was genuinely upstream -- P sent the block to us before we had it. This serves two purposes:

1. **Send action routing**: When the gossip protocol emits a send action with `trigger=A`, this module looks up which peer has A in their receivedFirst -- that peer is the target.
2. **Trigger-to-peer mapping**: The gossip protocol emits send actions with a `trigger` block. This module maps that trigger to a peer via receivedFirst. The gossip module's [claim history](gossip.md) determines *which* triggers to use; this module determines *which peer* each trigger maps to.

**Source integrity rule**: Blocks we sent to P that P later echoes back are **not** added to this set. Only blocks where P was the first sender count. This prevents circular inference.

**Pruning**: Blocks are removed from receivedFirst once all their outputs are claimed and their consensus relevance has faded. This bounds set size over time.

### Response Index

`responseIndex[V]` tracks how many V-relevant blocks have been pushed to peer P. This feeds the priority formula -- the Nth V-relevant push to P has its priority divided by N.

The counter increments on each push and does not reset when subscriptions expire. This prevents a burst of high-priority repushes when subscriptions churn on a high-activity verifier.

---

## Send Action Processing

When the gossip protocol emits a send action `(block=B, trigger=A, verifier=V, amount)`:

1. **Find target peers**: All peers P where A is in `P.receivedFirst`.
2. **Check awareness**: For each target P, check `P.knownBlocks`. If P already has B, skip.
3. **Compute priority**:
   ```
   push_priority = (amount / responseIndex[P][V])
                 * E[deliveryMatrix[B.source][P]]
                 / B.size
   ```
4. **Deduplicate**: If B is already in P's queue (from a different send action), keep the higher priority.
5. **Enqueue**: Add B to P's priority queue.

### Priority Components

- **`amount / responseIndex`**: Subscription priority. High-value first responses are top priority. The 50th response to a busy verifier needs 50x the amount to match the 1st.
- **`E[deliveryMatrix[B.source][P]]`**: Probability we'll be first to deliver. High when P is poorly connected to B's source. Low when P likely already has B from another path.
- **`1 / B.size`**: Prefer smaller blocks. Aggregation blocks are small despite representing large subtrees, giving them a natural advantage.

---

## Push Mechanism

### Immediate vs. Deferred

**Immediate push**: Send actions with priority above `IMMEDIATE_THRESHOLD` are pushed without waiting for queue processing. This ensures high-value subscription responses propagate with minimum latency. The only check is `P.knownBlocks`.

**Deferred push**: All other send actions enter per-peer priority queues. Queues are drained in priority order during normal bandwidth allocation.

### Push Flow

For each new send action:

1. Compute push priority.
2. If `P.knownBlocks` indicates P already has B, skip.
3. If priority > `IMMEDIATE_THRESHOLD`: push now, increment `responseIndex[P][V]`.
4. Otherwise: enqueue for deferred push.

When draining deferred queues:

1. Select the highest-priority entry across all peers (respecting per-peer bandwidth budgets).
2. Re-check `P.knownBlocks` (may have updated since enqueue).
3. Push block, increment `responseIndex[P][V]`.
4. Repeat until all budgets are exhausted or all queues are empty.

---

## Baseline Propagation

Not every block matches a subscription. New blocks with no subscription-triggered send actions still need to reach some peers to bootstrap into the subscription network.

For each new block B where the gossip protocol emits no send actions:
- Push B to a small number of peers at minimum priority
- Peer selection: prefer peers with high delivery rates for B's source, and peers with available bandwidth

This ensures:
- New blocks are not invisible to the network
- Blocks reach peers who may create subscriptions from their outputs
- The network remains connected even for rare or new verifiers

Baseline pushes respect bandwidth budgets and delivery matrix scoring. They are the lowest priority -- any subscription-triggered push takes precedence.

---

## Delivery Matrix

The delivery matrix learns network topology to avoid redundant deliveries.

### Structure

For each peer P, an array of Beta distributions indexed by block source:

`deliveryMatrix[s][P]` = `Beta(a, b)`:
- `a`: times a block from source `s` was novel to P when we forwarded it
- `b`: times a block from source `s` was already known to P

Expected first-delivery rate: `a / (a + b)`.

Prior: `Beta(1, 1)` (uniform -- willing to try until we learn otherwise).

Both `a` and `b` are periodically scaled down (multiplied by a decay factor < 1) so the distribution adapts to topology changes. When a peer disconnects, their matrix data is retained with accelerated decay in case they reconnect.

### Emergent Topology Learning

The matrix naturally encodes network topology without explicit discovery:

- If source S and destination D are directly connected -> low first-delivery rate (they share blocks directly)
- If S and D are distant -> high first-delivery rate (we are a useful relay)
- After a topology change -> old observations decay, new observations dominate

---

## Block Awareness

Peers track each other's block inventories to avoid redundant pushes and to update the delivery matrix.

### Mechanism

Pushed blocks are implicitly announced -- the push itself is the announcement. For blocks not pushed to a given peer, an explicit announcement is needed.

**Hash announcements**: Lightweight messages containing a batch of block hashes. Sent to peers for blocks we have but didn't push.

```
HashAnnounce {
    hashes: Hash[]
}
```

The receiving peer can fetch any announced blocks it wants via the fetch interface.

**Set reconciliation** (future): Periodic compact reconciliation using minisketch or IBLT for bandwidth-efficient inventory sync.

### Feedback Loop

After each awareness exchange with peer P:

1. For each block B we pushed to P since the last exchange:
   - P didn't have B -> success: increment `a` for `deliveryMatrix[B.source][P]`
   - P already had B -> failure: increment `b` for `deliveryMatrix[B.source][P]`
2. Blocks that P has and we don't are candidates for fetch (P was upstream for these).

---

## Reciprocity and Bandwidth

### Reciprocity Measurement

```
reciprocity(P) = utility_received(P) / utility_sent(P)
```

Both numerator and denominator use exponentially decayed sums. Utility is measured by subscription priority: how relevant were the pushes to the receiver's subscriptions. A block that matches many of our subscriptions has high received utility; a block we push that matches many of P's subscriptions has high sent utility.

### Bandwidth Allocation

```
bandwidthBudget(P) = BASE_RATE + BONUS_RATE * sigmoid(reciprocity(P) - 1)
```

- **`BASE_RATE`**: Guaranteed minimum for every peer. Prevents network fragmentation, allows new peers to bootstrap. Must support meaningful block exchange without enabling freeloading.
- **`BONUS_RATE`**: Additional bandwidth for reciprocal peers.
- **`sigmoid(reciprocity - 1)`**: Smooth transition centered at reciprocity = 1 (equal exchange). Peers contributing more than they receive get nearly full bonus; freeloaders get only base rate.

### Cold Start

New peers start with `reciprocity = 1` (neutral) and receive `BASE_RATE + BONUS_RATE/2`. Combined with the `Beta(1, 1)` delivery matrix prior, new peers get a fair trial period.

---

## Fetch Interface

Other modules (primarily sampling) may need specific blocks that haven't arrived via gossip:

```
fetch(hash: Hash): Promise<Block>
```

Fetch requests are routed to peers most likely to have the block (based on `knownBlocks` and the delivery matrix). Multiple peers may be queried in parallel for redundancy. Fetch requests are separate from push gossip and do not consume push bandwidth budgets.

---

## Message Types

The routing module uses three message types on the wire:

| Message | Direction | Description |
|---------|-----------|-------------|
| BlockPush | Outbound | Full block data. Implicitly announces the block to the receiver. |
| HashAnnounce | Bidirectional | Batch of block hashes for inventory sync. |
| FetchRequest / FetchResponse | Bidirectional | Request and deliver specific blocks by hash. |

---

## Concrete Example

### Setup

Three peers connected to us: Alice, Bob, Carol.
- Alice publishes blocks about game contract G.
- Bob publishes blocks about game contract G.
- Alice and Bob are directly connected to each other.
- Carol is only connected to us.

### Claim History Routing

Game executor D previously claimed `{G, config}` outputs. D's claiming block B_D is in our claim history. D sent us B_D, so B_D is in `D.receivedFirst`.

Alice sends us block B_A (output to `{G, config}`, value=10). B_A enters `Alice.receivedFirst`. The gossip protocol matches B_A's output against `claimHistory[{G, config}]`, finding B_D. It emits:
- `SendAction(block=B_A, trigger=B_D, verifier={G, config}, amount=...)` -- push Alice's request toward executor D.

Processing:
- B_D is in D's receivedFirst -> target = D
- `responseIndex[D][{G, config}]` = 1 (first push)
- `push_priority = amount/1 * E[deliveryMatrix[Alice][D]] / B_A.size`
- E[deliveryMatrix[Alice][D]] is initially 0.5 (uniform prior)
- Enqueue or push immediately depending on threshold

Bob sends us block B_B (output to `{G, config}`, value=8). Same matching -- routed toward D. Alice and Bob don't see each other's requests; only the executor does.

### Delivery Matrix Learning

We push B_A to D. D didn't have it. Success: `deliveryMatrix[Alice][D]` shifts toward 1.0.

We push B_A to Carol (baseline propagation -- Carol has no `{G, config}` claim history). Carol doesn't have it. Success: `deliveryMatrix[Alice][Carol]` shifts toward 1.0. Carol depends on us for Alice's blocks.

### Topology Change

D disconnects from us and reconnects through a relay. Blocks from Alice that we push to D are now sometimes redundant (D gets them through the relay). `deliveryMatrix[Alice][D]` adapts downward. We reduce relay effort for Alice->D traffic.

### Reciprocity

Carol receives blocks from us but rarely sends useful blocks back:
```
reciprocity(Carol) ~= 0.3
bandwidthBudget(Carol) ~= BASE_RATE + 0.15 * BONUS_RATE
```

Bob actively reciprocates with game contract blocks:
```
reciprocity(Bob) ~= 1.2
bandwidthBudget(Bob) ~= BASE_RATE + 0.55 * BONUS_RATE
```

Bob gets more bandwidth; Carol gets less. Both remain connected.

---

## Emergent Behaviors

**Topology-aware routing.** The delivery matrix learns which peer pairs are connected without explicit topology discovery. Redundant relay paths are deprioritized; bridging paths are promoted.

**Interest clustering.** Through `receivedFirst` and claim history, peers that participate in related economic activity naturally cluster. Blocks about game G propagate efficiently among G participants without flooding the entire network.

**Natural backpressure.** Bandwidth budgets and response index create natural backpressure. High-activity verifiers see later responses deprioritized. When the network is busy, only high-value responses propagate immediately.

**Freeloader isolation.** Peers that consume gossip without reciprocating see their bandwidth drop to `BASE_RATE`. They still participate (preventing fragmentation) but at reduced priority. Useful peers naturally receive better service.

---

## Interaction with Other Modules

**Gossip protocol**: Provides send actions. This module maintains `receivedFirst` sets that map trigger blocks to peers, enabling the gossip protocol's send actions to reach the correct network destinations. See [gossip protocol](gossip.md).

**Consensus module**: Provides canonical view for the UTXO index, which the gossip protocol queries during backfill.

**Sampling module**: Submits fetch requests for specific blocks needed during verification. This module fulfills them through the fetch interface.

**PeerModule**: Provides the current peer set and transport-level metrics (latency, throughput). Receives gossip quality scores for connection decisions. Gossip quality for peer P is a function of: first-delivery novelty, reciprocity, and fetch responsiveness.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Send actions | Gossip protocol | `(block, trigger, verifier, amount)` tuples to deliver |
| New blocks | Network / local creation | Blocks received from peers (updates receivedFirst, knownBlocks) |
| Peer set + transport metrics | PeerModule | Current peers, latency, throughput |
| Fetch requests | Sampling module | Specific blocks needed for verification |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Pushed blocks | Peers (network) | Blocks sent to specific peers |
| Subscription sources | Gossip protocol | Blocks entering receivedFirst (to add to subscription index) |
| Fetched blocks | Sampling module | Blocks retrieved on request |
| Gossip quality scores | PeerModule | Per-peer usefulness metric for connection decisions |
| Block availability | All modules | Whether a block is locally available |

### Invariants

1. **No blind forwarding**: Every push is justified by a send action (subscription match) or baseline propagation -- no block is forwarded to all peers unconditionally.
2. **Bandwidth bounded**: Each peer receives at most `bandwidthBudget(P)` bytes/sec of pushed blocks.
3. **Monotonic awareness**: Once a peer is known to have a block, that knowledge is never retracted.
4. **Source integrity**: `receivedFirst` only contains blocks where the peer was genuinely upstream, never echoes of our own pushes.
5. **Reciprocity floor**: Every peer receives at least `BASE_RATE` bandwidth regardless of reciprocity score.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/node/RoutingModule.ts`](../../src/node/RoutingModule.ts) | Send action processing, peer state, delivery matrix, bandwidth |
| [`src/node/RoutingService.ts`](../../src/node/RoutingService.ts) | Wired adapter using concrete `Block` type |
