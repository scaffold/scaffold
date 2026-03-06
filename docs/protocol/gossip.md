# Gossip Module

The gossip module distributes blocks to peers. Its goal is **fast, efficient propagation**: every peer receives relevant blocks quickly, without wasting bandwidth on redundant deliveries. The primary mechanism is **push-based gossip** — peers proactively send blocks they believe will be useful, rather than waiting for requests.

This module is responsible for:
- Deciding which blocks to push to which peers
- Computing block utility per peer
- Learning network topology to avoid redundant deliveries
- Managing per-peer bandwidth budgets
- Providing a block fetch interface for other modules (e.g., sampling)

This module is **not** responsible for:
- Peer discovery or connection management (PeerModule)
- Block validation or verification (verification module)
- Deciding what blocks to create (block creation module)

---

## Block Model

At this module, a block is:

```
Block {
    hash:    Hash      // unique identifier
    size:    Number    // serialized size in bytes
    source:  PeerID?   // peer we first received this block from (null if self-originated)
}
```

Everything else (weight, claims, collateral, payments) is accessed through providers when computing utility. The gossip module does not interpret block internals — it consults other modules for relevance signals.

Note: aggregation blocks are small despite representing large subtrees. The block header contains only the merkle root of its claim mask, not the full bit vector (see conflict module). The serialized size used for bandwidth budgeting reflects actual bytes on the wire.

---

## Peer State

For each connected peer P, the module maintains:

```
PeerState {
    receivedFirst:     Set<Hash>                    // blocks we received first from P
    knownBlocks:       BlockAwareness               // compact representation of P's block inventory
    deliveryMatrix:    Map<PeerID | Self, Beta>      // first-delivery rates by source
    reciprocity:       Number                        // utility_received / utility_sent (decayed)
    bandwidthBudget:   Number                        // bytes/sec allocated to this peer
}
```

### Received-First Set

`receivedFirst` tracks blocks where P was genuinely upstream — P sent the block to us before we had it. This is the core signal for relevance scoring: if P (or P's upstream peers) sent us block X, they likely have interest in blocks that interact with X.

**Source integrity rule**: Blocks we sent to P that P later echoes back are **not** added to this set. Only blocks where P was the first sender count. This prevents circular inference — if we push block X to P and P echoes it, we must not then infer that P is interested in X-related blocks. The interest signal flows one direction: upstream to us.

`receivedFirst` should be pruned over time. Once a block is deeply buried under verified descendant weight, responses to it are unlikely. Blocks can be removed from the set once their consensus relevance fades.

### Delivery Matrix

The delivery matrix is an N×N matrix of Beta distributions indexed by (source, destination), plus a "self" row for blocks we originate. For each peer P:

`deliveryMatrix[s]` = `Beta(α, β)`:
- `α`: times a block from source `s` was novel to P when we forwarded it
- `β`: times a block from source `s` was already known to P

Expected first-delivery rate: `α / (α + β)`.

Prior: `Beta(1, 1)` (uniform — willing to try forwarding until we learn otherwise).

Both `α` and `β` are periodically scaled down (multiplied by a decay factor < 1) so the distribution adapts to topology changes. When a peer disconnects, their matrix data is retained with accelerated decay in case they reconnect.

The matrix naturally encodes network topology without explicit discovery:
- If source S and destination D are directly connected → low first-delivery rate (they already share blocks directly)
- If S and D are distant → high first-delivery rate (we are a useful relay)
- After a topology change → old observations decay, new observations dominate

---

## Utility Scoring

For a block B and peer P, utility determines whether to push B to P and at what priority.

```
utility(B, P) = base(B) × relevance(B, P)
```

### Base Utility

Base utility reflects the block's importance to the network:

```
base(B) = sum(B.weight) + contestedness(B) × stake(B)
```

Where:
- `sum(B.weight)` is the total declared weight (from consensus module). High-weight blocks are influential for consensus and should propagate quickly.
- `contestedness(B)` applies when B is the target of collateral. Defined as `min(for_stake, against_stake) / max(for_stake, against_stake)`, so fully contested blocks (equal FOR and AGAINST stakes) have contestedness = 1. Only applies above a minimum stake threshold — low-stake disputes are not worth aggressive propagation.
- `stake(B)` is the total collateral at risk on B (sum of FOR and AGAINST).

### Relevance

Relevance measures how likely P is to care about B. It is primarily based on `P.receivedFirst` — the set of blocks P routed to us:

```
relevance(B, P) = max(
    R_CLAIM        if B claims an output of any block in P.receivedFirst,
    R_COLLATERAL   if B is collateral for/against any block in P.receivedFirst,
    R_AGGREGATE    if B aggregates any block in P.receivedFirst,
    R_PAYMENT      if B contains a payment output restricted to P's pubkey,
    R_DEFAULT      otherwise
)
```

Where `R_PAYMENT > R_CLAIM ≥ R_COLLATERAL ≥ R_AGGREGATE > R_DEFAULT > 0`.

**Why `receivedFirst` and not published blocks**: We don't need to know what P published. If P sent us block X, either P created X (and is directly interested) or P is forwarding from an interested peer (and the fastest route back is through P). Both cases are handled uniformly. This also avoids needing to learn P's publishing identity.

**Payments are special**: Payment outputs restricted to P's pubkey are always highly relevant regardless of `receivedFirst`. These use P's connection identity (pubkey) rather than routing history.

`R_DEFAULT` ensures every block has baseline relevance — even unrelated blocks should propagate through the network. Without this, isolated subgraphs could starve.

### Push Priority

The push decision combines utility with novelty and bandwidth cost:

```
priority(B, P) = utility(B, P) × E[deliveryMatrix[B.source][P]] / B.size
```

This is utility per byte, weighted by the probability we'll be the first to deliver. Blocks are pushed in priority order until P's bandwidth budget is exhausted.

For self-originated blocks, `B.source = Self` and the self row of the delivery matrix is used.

---

## Push Mechanism

### Two-Tier Push

Blocks are classified into two tiers based on urgency:

**Immediate push**: Blocks with `utility(B, P) > IMMEDIATE_THRESHOLD` are pushed without waiting for awareness exchange. This ensures consensus-critical blocks (high weight, contested collateral, payments) propagate with minimum latency. The only check is whether `P.knownBlocks` already indicates P has the block.

**Deferred push**: All other blocks enter a per-peer priority queue. They are pushed in priority order during normal bandwidth allocation, informed by awareness-based knowledge of what peers already have.

### Push Decision

For each new block B and each peer P:

1. Compute `priority(B, P)`.
2. If below minimum threshold, skip.
3. If `P.knownBlocks` indicates P already has B, skip.
4. If immediate tier: send now.
5. Otherwise: enqueue for deferred sending at computed priority.

---

## Block Awareness

Peers maintain awareness of each other's block inventories using **compact set representations**. This serves two purposes:

1. **Avoid redundant pushes** — don't send blocks the peer already has.
2. **Update the delivery matrix** — learn which forwards were novel vs. redundant.

### Interface

The awareness mechanism is abstracted behind a provider:

```
BlockAwareness {
    has(block: Hash): boolean | unknown    // does this peer have the block?
    announce(block: Hash): void            // inform peer we have this block
    exchange(): SetDiff                    // reconcile inventories, return diff
}
```

Implementations may include:
- **Hash relay**: Broadcast each new block's hash to all peers. Simple, O(peers × blocks) messages. Good for low peer counts.
- **Set sketches** (minisketch/IBLT): Periodic compact set reconciliation. More bandwidth-efficient for large inventories, slightly higher latency for individual block awareness.

Pushed blocks are implicitly announced — the push itself is the announcement. The awareness mechanism only needs to cover blocks we **don't** push (because their priority was too low for a given peer).

### Feedback Loop

After each awareness exchange with peer P, the module updates the delivery matrix:

1. For each block B we pushed to P since the last exchange:
   - If P didn't have B → success: increment `α` for `deliveryMatrix[B.source][P]`.
   - If P already had B → failure: increment `β` for `deliveryMatrix[B.source][P]`.
2. Blocks that P has and we don't are candidates for fetch (P was upstream for these).

---

## Reciprocity

Peers that provide useful gossip receive preferential treatment. The tit-for-tat mechanism allocates more bandwidth to peers that reciprocate.

### Measurement

```
reciprocity(P) = utility_received(P) / utility_sent(P)
```

Both numerator and denominator use exponentially decayed sums. `utility_received` is the sum of `utility(B, us)` for blocks P pushed to us. `utility_sent` is the sum of `utility(B, P)` for blocks we pushed to P. The utility function is the same in both directions, providing a common measure.

### Bandwidth Allocation

```
bandwidthBudget(P) = BASE_RATE + BONUS_RATE × sigmoid(reciprocity(P) - 1)
```

- **`BASE_RATE`**: Guaranteed minimum bandwidth for every peer. Prevents network fragmentation and allows new peers to bootstrap. Must be large enough for meaningful block exchange but small enough that freeloaders don't consume significant resources.
- **`BONUS_RATE`**: Additional bandwidth for reciprocal peers.
- **`sigmoid(reciprocity - 1)`**: Smooth transition centered at reciprocity = 1 (equal exchange). Peers contributing more than they receive get nearly full bonus; freeloaders get only base rate.

### Cold Start

New peers start with `reciprocity = 1` (neutral) and receive `BASE_RATE + BONUS_RATE/2`. As the relationship develops, the budget adjusts. Combined with the `Beta(1, 1)` delivery matrix prior, this ensures new peers get a fair trial period.

---

## Fetch Interface

Other modules (primarily sampling) may need specific blocks that haven't arrived via gossip. The gossip module provides a fetch interface:

```
fetch(hash: Hash): Promise<Block>
```

Fetch requests are routed to peers most likely to have the block (based on `knownBlocks` and the delivery matrix). Multiple peers may be queried in parallel for redundancy. Fetch requests are separate from push gossip and do not consume push bandwidth budgets.

---

## Emergent Behaviors

**Topology-aware routing.** The delivery matrix naturally learns which peer pairs are connected. Without explicit topology discovery, the module stops forwarding between well-connected peers and focuses bandwidth on bridging gaps. This adapts automatically as the network topology changes.

**Interest clustering.** Through `receivedFirst`, peers that participate in related economic activity naturally cluster. If peer P consistently sends us blocks about resource X, we route X-related blocks back through P. This creates efficient routing paths without global coordination.

**Aggressive fraud propagation.** Contested collateral (high contestedness × high stake) receives elevated base utility, causing it to propagate aggressively through the network. This ensures fraud evidence reaches all interested parties quickly, supporting the trust module's economic guarantees.

**Natural backpressure.** The bandwidth budget mechanism creates natural backpressure. When the network is busy, only high-utility blocks propagate immediately. Lower-utility blocks wait for deferred push, automatically smoothing traffic without explicit congestion control.

**Freeloader isolation.** Peers that consume gossip without providing useful blocks see their reciprocity score drop, reducing their bandwidth allocation to `BASE_RATE`. They still participate (preventing network fragmentation) but at reduced priority. Useful peers naturally receive better service.

---

## Concrete Example

### Setup

Three peers connected to us: Alice, Bob, Carol.
- Alice publishes blocks about resource R1.
- Bob publishes blocks about resource R2.
- Alice and Bob are directly connected to each other.
- Carol is only connected to us.

### Learning Phase

Initial delivery matrix: all `Beta(1, 1)`, E[first-delivery rate] = 0.5.

We forward Alice's blocks to Bob. Most times, Bob already has them (via his direct connection to Alice). After 20 blocks: `deliveryMatrix[Alice][Bob] ≈ Beta(4, 18)`, E ≈ 0.18. We learn that forwarding Alice → Bob is mostly wasteful.

We forward Alice's blocks to Carol. Carol rarely has them already. After 20 blocks: `deliveryMatrix[Alice][Carol] ≈ Beta(18, 4)`, E ≈ 0.82. We learn that Carol depends on us for Alice's blocks.

### Utility-Driven Routing

Block X arrives from Alice. X claims an output of block R1_5, which is in `Alice.receivedFirst`.

| Peer | Relevance | Novelty | Priority |
|------|-----------|---------|----------|
| Bob | `R_DEFAULT` (R1_5 not in Bob's receivedFirst) | 0.18 | Low |
| Carol | `R_DEFAULT` | 0.82 | Moderate |

Block Y arrives: collateral against a block in `Bob.receivedFirst`, with high contestedness.

| Peer | Relevance | Novelty | Priority |
|------|-----------|---------|----------|
| Bob | `R_COLLATERAL` × high contestedness | 0.18 | Despite low novelty, high utility pushes Y above `IMMEDIATE_THRESHOLD` → immediate push |
| Carol | `R_DEFAULT` | 0.82 | Moderate → deferred push |

### Topology Change

Alice disconnects from Bob. Bob stops receiving Alice's blocks directly.

We continue forwarding Alice's blocks to Bob. They are now consistently novel. Over 20 more blocks: `deliveryMatrix[Alice][Bob]` shifts toward `Beta(20, 20)`, E ≈ 0.50, and continues rising. The module automatically adapts to route Alice → Bob traffic through us.

### Reciprocity in Action

Carol receives blocks from us but rarely sends useful blocks back. After the cold start period:

```
reciprocity(Carol) ≈ 0.3 (sending 3× more than receiving)
bandwidthBudget(Carol) ≈ BASE_RATE + BONUS_RATE × sigmoid(-0.7) ≈ BASE_RATE + 0.15 × BONUS_RATE
```

Bob actively reciprocates with R2 blocks:

```
reciprocity(Bob) ≈ 1.2
bandwidthBudget(Bob) ≈ BASE_RATE + BONUS_RATE × sigmoid(0.2) ≈ BASE_RATE + 0.55 × BONUS_RATE
```

Bob gets more bandwidth; Carol gets less. Both remain connected.

---

## Interaction with Other Modules

**Consensus module**: Provides block weight vectors and canonical view. The gossip module uses weight for base utility and canonical status for contestedness. High-weight blocks near the chain tip are the highest priority for propagation.

**Conflict module**: Provides claim relationships. The gossip module uses these to determine relevance — if B claims an output of a block in `P.receivedFirst`, B is relevant to P.

**Trust module**: Provides collateral placements and stake amounts. The gossip module uses these for contestedness scoring (is this block actively disputed?) and collateral relevance (is this collateral related to something P cares about?).

**Sampling module**: Submits fetch requests for specific blocks needed during verification. The gossip module fulfills these through the fetch interface, routing requests to peers most likely to have the block.

**PeerModule**: Provides the current peer set and transport-level metrics (latency, throughput). Receives gossip quality scores for connection decisions. Gossip quality for peer P is a function of: first-delivery novelty (how often P sends us blocks we don't have), reciprocity, and responsiveness to fetch requests.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| New blocks | Network / local creation | Blocks to potentially gossip |
| Block weight vectors | Consensus module | `sum(weight)` for base utility computation |
| Canonical view | Consensus module | For contestedness assessment |
| Claim relationships | Conflict module | Which blocks claim which outputs |
| Collateral state | Trust module | FOR/AGAINST stakes per block |
| Peer set + transport metrics | PeerModule | Current peers, latency, throughput |
| Fetch requests | Sampling module | Specific blocks needed for verification |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Pushed blocks | Peers (network) | Blocks sent to specific peers based on utility scoring |
| Fetched blocks | Sampling module | Blocks retrieved on request |
| Gossip quality scores | PeerModule | Per-peer usefulness metric for connection decisions |
| Block availability | All modules | Whether a block is locally available |

### Invariants

1. **No blind forwarding**: Every push decision is justified by utility scoring — no block is forwarded to all peers unconditionally.
2. **Bandwidth bounded**: Each peer receives at most `bandwidthBudget(P)` bytes/sec of pushed blocks.
3. **Monotonic awareness**: Once a peer is known to have a block, that knowledge is never retracted.
4. **Source integrity**: `receivedFirst` only contains blocks where the peer was genuinely upstream, never echoes of our own pushes.
5. **Reciprocity floor**: Every peer receives at least `BASE_RATE` bandwidth regardless of reciprocity score.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/GossipModule.ts`](../../src/core/GossipModule.ts) | Core algorithm: utility scoring, delivery matrix, bandwidth budgeting |
| [`src/core/GossipService.ts`](../../src/core/GossipService.ts) | Wired adapter using concrete `Block` type |
