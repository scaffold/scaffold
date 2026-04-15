# Gossip Protocol

The gossip protocol determines which blocks need to reach which parts of the network. Its mechanism is **verifier-based subscriptions**: blocks with unclaimed outputs create implicit subscriptions, and new blocks that match those subscriptions generate **send actions** -- directives to deliver a block toward a specific subscription source.

This protocol is the "what to send" layer. It has no knowledge of peers, bandwidth, or network topology. The [routing module](routing.md) handles delivery -- mapping send actions to specific peers and managing bandwidth.

This module is responsible for:
- Maintaining the subscription index (verifier to subscription source mapping)
- Generating send actions when blocks match subscriptions
- Computing base priority for send actions
- Managing subscription lifecycle (creation, expiry, migration)

This module is **not** responsible for:
- Choosing which peer receives a block (routing module)
- Bandwidth allocation or delivery optimization (routing module)
- Peer discovery or connection management (PeerModule)
- Block validation or verification (verification module)

---

## Subscriptions

A **subscription** is an unclaimed output on a block. Every unclaimed output creates an implicit subscription to its verifier -- a standing interest in blocks that output to the same verifier or claim outputs of that verifier.

Subscriptions are maintained in a **subscription index**:

```
subscriptionIndex: Map<Verifier, Set<{block: Hash, outputIndex: number}>>
```

An entry `{V -> [{B, 3}, {C, 0}]}` means: block B's output 3 and block C's output 0 both have verifier V and are unclaimed. Any new block that outputs to V or claims a V output is relevant to these subscription sources.

### Verifier Matching

A verifier is a `{contract: Hash, params: Uint8Array}` pair. Matching is exact -- both contract and params must match. Two outputs with the same contract but different params are different subscriptions.

This means:
- `{SIGNATURE_CONTRACT, pubkey_A}` and `{SIGNATURE_CONTRACT, pubkey_B}` are separate subscriptions
- Each block's aggregation marker has a unique verifier, so aggregation subscriptions are block-specific
- Subscribing to "all outputs of contract C" is not possible -- subscriptions are always to specific verifier instances

### Subscription Sources

The [routing module](routing.md) controls which blocks enter the subscription index. Blocks enter when they appear in any peer's `receivedFirst` set, when we create them locally, or when they arrive via fetch. The gossip protocol maintains the index and matches against it, but does not decide which blocks are added.

---

## Send Actions

When a new block arrives, the gossip protocol checks it against the subscription index and emits **send actions**:

```
SendAction {
    block:    Hash       // the block to deliver
    trigger:  Hash       // the subscription source this responds to
    verifier: Verifier   // the matching verifier
    amount:   number     // value of the matched output (for priority)
}
```

### Matching Rules

When block B arrives:

**New subscription content.** For each of B's unclaimed outputs with verifier V:

1. For each existing source A in `subscriptionIndex[V]`: emit `SendAction(block=B, trigger=A, verifier=V, amount=A.output.value)`. This pushes B toward A's subscriber path.
2. Add B to `subscriptionIndex[V]`.
3. For each existing source A in `subscriptionIndex[V]` where A != B: emit `SendAction(block=A, trigger=B, verifier=V, amount=B.output.value)`. This backfills -- pushing existing V content toward B's subscriber path.

Step 3 is critical. Without it, a new subscriber would only see future V blocks, not existing ones. A peer that just subscribed to V should receive the current state of V, not just updates.

**Claim notification.** For each of B's claims that resolves to an output with verifier V:

4. For each source A in `subscriptionIndex[V]`: emit `SendAction(block=B, trigger=A, verifier=V, amount=A.output.value)`. This notifies V subscribers of the claim.
5. Remove the claimed output from `subscriptionIndex[V]`.

A single block can trigger both rules -- it may output to V (new subscription content) and claim V outputs (claim notification) in the same block.

### Self-Claim Exclusion

Self-claimed outputs (index < block.outputs.length where the same index appears in claims) are never added to the subscription index. They are produced and consumed atomically and never enter the UTXO set.

---

## Priority

Each send action carries an `amount` -- the value of the matched subscription output. The [routing module](routing.md) combines this with per-peer state for the final push priority:

```
subscription_priority(action, peer) = action.amount / response_index(peer, action.verifier)
```

Where `response_index(peer, V)` is a per-peer counter maintained by the routing module that increments each time a V-relevant block is pushed to that peer. This demotes later responses for high-activity subscriptions:

| Response | Priority (amount=100) |
|----------|----------------------|
| 1st | 100 |
| 2nd | 50 |
| 10th | 10 |
| 100th | 1 |

High-value responses always punch through regardless of response index. Low-value responses to high-activity verifiers are naturally deprioritized, preventing bandwidth saturation from a single busy subscription.

---

## Subscription Lifecycle

### Creation

A subscription is created when a block with an unclaimed output enters the subscription index. The routing module decides which blocks to add (typically from peer `receivedFirst` sets and local creations).

### Expiry

A subscription expires when its output is claimed by a canonical block. The claimed output is removed from the subscription index. If no other unclaimed outputs for that verifier remain, the verifier entry is removed entirely.

### Aggregation Migration

When block A gets aggregated by block E:
- E claims A's aggregation marker output -> A's aggregation marker subscription expires.
- E produces its own aggregation marker output -> if E enters the subscription index, a new subscription is created for E's marker verifier.

Subscriptions naturally **migrate up the aggregation chain**. A peer watching block A sees A get aggregated (via the claim notification), and E's marker creates a new subscription. When E is later aggregated by F, the same migration happens. The peer's subscriptions track the live edge of the DAG without any explicit frontier data structure.

### Canonical State Changes

When the canonical view changes:
- Outputs that become unclaimed (their claiming block became non-canonical) re-enter the subscription index.
- Outputs that become claimed (a previously non-canonical claim becomes canonical) leave the index.

---

## Why Every Previous Relevance Case Is Subsumed

The subscription mechanism replaces the previous per-category relevance function:

| Previous Category | How Subscriptions Handle It |
|---|---|
| R_CLAIM (B claims output of a block P cares about) | B claims a V output. V is in the subscription index. Claim notification emitted. |
| R_AGGREGATE (B aggregates a block P cares about) | Aggregation claims the aggregation marker. Same mechanism -- the marker's verifier is in the subscription index. |
| R_COLLATERAL (B is collateral for/against a block) | Opt-in: a peer posts a zero-value output to the collateral verifier to subscribe. Collateral activity then triggers subscription matches. |
| R_PAYMENT (B pays P's pubkey) | P subscribes to `{SIGNATURE_CONTRACT, P.pubkey}` by having an output to it. Payments to P match the subscription. |

### No Base Utility Needed

Large aggregation blocks propagate widely because they claim many aggregation markers. Each claimed marker triggers send actions toward that marker's subscribers. A block aggregating 100 subtrees generates send actions toward all 100 subscriber paths. The "importance" of a block is implicit in how many subscriptions it matches.

---

## Future Extensions

**Fraud broadcast.** The subscription model routes blocks to interested parties, but some blocks -- particularly AGAINST collateral challenges -- may need to reach peers who have no existing subscription. When a peer litigates against a block, the challenge should propagate as widely as possible so that other verifiers can pile on (the voting cascade described in [trust.md](trust.md)). The subscription mechanism alone is insufficient here: peers who could profitably verify and post their own AGAINST votes may not have subscribed to the target block's collateral verifier.

This likely requires a separate **broadcast action** alongside the subscription-based send action. A broadcast action would not be targeted at a specific subscription trigger -- it would instead be pushed to all peers, prioritized by a contestedness metric:

```
contestedness(B) = min(for_stake, against_stake) / max(for_stake, against_stake)
broadcast_priority = contestedness(B) * total_stake(B)
```

Fully contested blocks (equal FOR and AGAINST stakes with high total value) would propagate most aggressively. The routing module would handle broadcast actions separately from subscription send actions -- draining from a shared bandwidth budget but bypassing the subscription-based peer targeting. The exact mechanism is deferred until the collateral resolution system is fully specified.

**Unspentness proofs.** Claim masks are currently stored as sorted index arrays. In a future revision, these will be replaced with merkle trees, enabling compact proofs that a specific output is NOT claimed at a given aggregation level. This will allow the protocol to push not just blocks but also proofs of unspentness -- blocks along the aggregation path with merkle exclusion proofs at each level.

**Cross-network discovery.** The current design relies on gossip propagation to spread V-relevant blocks to all V subscribers. In large networks, this may be slow for rare verifiers. A future extension could map verifiers to synchronization points in the network (an implicit DHT), ensuring V-relevant blocks converge at a known location regardless of gossip path length.

---

## Concrete Example

### Setup

Alice publishes block B_A with outputs:
- `[0]`: `{GAME_CONTRACT, config}`, value=10 (game tick request)
- `[1]`: `{AGGREGATION_CONTRACT, ...}`, value=0 (aggregation marker)

B_A enters the subscription index:
- `{GAME_CONTRACT, config}` -> `[{B_A, 0}]`
- `{AGGREGATION_CONTRACT, ...}` -> `[{B_A, 1}]`

### Second Subscriber

Bob publishes block B_B with output `[0]`: `{GAME_CONTRACT, config}`, value=8.

Processing B_B's outputs:

1. Check `subscriptionIndex[{GAME_CONTRACT, config}]`. B_A is there. Emit:
   `SendAction(block=B_B, trigger=B_A, verifier={GAME_CONTRACT, config}, amount=10)`

2. Add B_B to the subscription index.

3. Backfill: B_A is in the index. Emit:
   `SendAction(block=B_A, trigger=B_B, verifier={GAME_CONTRACT, config}, amount=8)`

Result: B_B is pushed toward Alice (B_A's subscriber path). B_A is pushed toward Bob (B_B's subscriber path). Both players discover each other's requests.

### Response

Peer D publishes block B_resp, claiming B_A's output 0 (the game tick request). B_resp has outputs:
- `[0]`: `{GAME_CONTRACT, config}`, value=8 (next request)
- `[1]`: `{SIGNATURE_CONTRACT, D.pubkey}`, value=2 (fee)

**Claim notification** (step 4): B_resp claims B_A output 0, verifier = `{GAME_CONTRACT, config}`. Both B_A and B_B are in the subscription index. Emit:
- `SendAction(block=B_resp, trigger=B_A, amount=10)` -- notify Alice
- `SendAction(block=B_resp, trigger=B_B, amount=8)` -- notify Bob

**Expiry** (step 5): Remove `{B_A, 0}` from subscription index. B_A output 0 is claimed.

**New subscription** (steps 1-3): B_resp output 0 has `{GAME_CONTRACT, config}`. Add to index. Backfill: B_B is there. Emit:
- `SendAction(block=B_resp, trigger=B_B, amount=8)` (already covered by claim notification)
- `SendAction(block=B_B, trigger=B_resp, amount=8)` -- push B_B toward D's subscriber path

### Aggregation

Aggregator E claims B_A's aggregation marker (output 1). Emit:
`SendAction(block=E, trigger=B_A, verifier={AGGREGATION_CONTRACT, ...}, amount=0)`

B_A's marker subscription expires. E's own marker enters the index. When E is later aggregated by F, the subscription migrates again.

---

## Interaction with Other Modules

**Routing module**: Receives send actions, maps triggers to peers, manages delivery. Feeds the subscription index by reporting which blocks should be tracked. See [routing module](routing.md).

**Output claims module**: Provides resolved claim data -- when a claim resolves to `{block, outputIndex}`, the gossip protocol looks up the claimed output's verifier for subscription matching. Reports canonical claim state changes for subscription expiry.

**Consensus module**: Provides canonical view. The subscription index tracks only canonical, unclaimed outputs. Canonical state changes trigger subscription re-evaluation.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| New blocks | Network / local creation | Blocks to evaluate against subscription index |
| Claim resolutions | Output claims module | Which output (block, index, verifier) each claim resolves to |
| Canonical UTXO state | Consensus module | Which outputs are currently unclaimed |
| Subscription sources | Routing module | Which blocks to add to the subscription index |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Send actions | Routing module | `(block, trigger, verifier, amount)` tuples for delivery |

### Invariants

1. **Subscription correctness**: Every entry in the subscription index corresponds to a canonical, unclaimed output.
2. **Completeness**: Every new block is checked against the full subscription index. No subscription match is missed.
3. **Bidirectional matching**: When a new V block arrives, both directions are handled -- existing V subscribers see the new block, and the new subscriber sees existing V content.
4. **Claim expiry**: When an output is claimed, its subscription entry is removed before further matching.
5. **Self-claim exclusion**: Self-claimed outputs never enter the subscription index.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/node/GossipModule.ts`](../../src/node/GossipModule.ts) | Subscription index, send action generation, subscription lifecycle |
| [`src/node/GossipService.ts`](../../src/node/GossipService.ts) | Wired adapter using concrete `Block` type |
