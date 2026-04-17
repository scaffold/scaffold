# Gossip Protocol

The gossip protocol determines which blocks need to reach which parts of the network. Its mechanism is **claim-history routing**: blocks are routed toward peers who have previously claimed outputs of matching verifiers.

This protocol is the "what to send" layer. It has no knowledge of peers, bandwidth, or network topology. The [routing module](routing.md) handles delivery -- mapping send actions to specific peers and managing bandwidth.

This module is responsible for:
- Maintaining the claim history index (verifier to historical claimers mapping)
- Generating send actions when blocks match claim history entries
- Computing base priority for send actions
- Managing claim history lifecycle (addition, pruning)

This module is **not** responsible for:
- Choosing which peer receives a block (routing module)
- Bandwidth allocation or delivery optimization (routing module)
- Peer discovery or connection management (see [transport layer](transport.md))
- Block validation or verification (verification module)

---

## Claim History Index

The gossip module maintains a **claim history index**: a record of which blocks have claimed outputs of each verifier. When a new block arrives with outputs to a verifier, it is routed toward peers who have historically claimed that verifier -- peers who have demonstrated both the ability and the interest to serve it.

```
claimHistory:      Map<VerifierKey, ClaimEntry[]>
contractFallback:  Map<ContractHashHex, ClaimEntry[]>
```

A `ClaimEntry` records a single claim event:

```
ClaimEntry {
    block:   Hash     // the block that made the claim
    amount:  number   // value of the claimed output
    seq:     number   // monotonic sequence number for recency
}
```

An entry `{V -> [{B, 100, 5}, {C, 50, 8}]}` means: block B claimed a V-output worth 100 (seq 5), and block C later claimed a V-output worth 50 (seq 8). Any new block with outputs to V is relevant to B's and C's publisher paths.

### Verifier Matching

A verifier is a `{contract: Hash, params: Uint8Array}` pair. Matching is exact -- both contract and params must match. Two outputs with the same contract but different params are different verifiers.

This means:
- `{SIGNATURE_CONTRACT, pubkey_A}` and `{SIGNATURE_CONTRACT, pubkey_B}` have separate claim histories
- Each block's aggregation marker has a unique verifier, so aggregation claim history is block-specific
- Subscribing to "all outputs of contract C" is not possible -- claim history is always per verifier instance

### Contract-Level Fallback

When `claimHistory[V]` is empty, the module falls back to `contractFallback`, which indexes claim history by contract hash only (ignoring params). This provides a degraded routing signal for verifiers that have never been claimed with those specific params.

This is useful for bootstrapping: a new game configuration has no claim history, but peers who have previously claimed any game contract output are reasonable targets.

### Bounded History

Each verifier's claim history is bounded to a maximum number of entries. When the limit is exceeded, entries are pruned by a recency-weighted score:

```
score(entry) = entry.amount * (1 / (1 + (currentSeq - entry.seq) / maxEntries))
```

Recent high-value claims survive; old low-value claims are pruned. This prevents unbounded growth for popular verifiers while preserving the most useful routing signals.

---

## Send Actions

When claim history is updated or a new block arrives, the gossip protocol emits **send actions**:

```
SendAction {
    block:    Hash       // the block to deliver
    trigger:  Hash       // the target block (routes toward this block's publisher path)
    verifier: VerifierKey // the matching verifier
    amount:   number     // value (for priority)
}
```

### Matching Rules

The gossip module applies two rules:

**Rule 1: Route claims back toward their claimed output.**

When a claim resolves -- block B claims an output of block A with verifier V:

1. Emit `SendAction(block=B, trigger=A, verifier=V, amount=claimed_value)`. This routes the claiming block back toward the output's publisher.
2. Add B to `claimHistory[V]` and `contractFallback[V.contract]`.
3. **Backfill**: query the UTXO index for existing unclaimed outputs with verifier V. For each unclaimed output on block X (where X != B), emit `SendAction(block=X, trigger=B, verifier=V, amount=entry_amount)`. This routes existing work toward the new capable peer.

Rule 1 fires via `notifyClaimResolved` as claims resolve gradually through `OutputClaimModule`'s migration. It does not fire during `blockReceived`, because network blocks arrive without resolved claim data.

**Rule 2: Route outputs toward historical claimers.**

When block B arrives with an unclaimed output to verifier V:

4. For each entry E in `claimHistory[V]` (with contract-level fallback if empty): emit `SendAction(block=B, trigger=E.block, verifier=V, amount=E.amount)`. This routes new content toward peers who can serve it.

Rule 2 fires during `blockReceived`.

**Processing order.** The Coordinator processes a block first (resolving claims, which fires Rule 1 and populates claim history), then the routing module calls `gossip.blockReceived` (which fires Rule 2 against the now-updated claim history). This ensures claim history is current when output matching runs.

### Self-Claim Exclusion

Self-claimed outputs (index < block.outputs.length where the same index appears in claims) do not generate claim history entries or send actions. They are produced and consumed atomically and never enter the UTXO set.

---

## Priority

Each send action carries an `amount`. The [routing module](routing.md) combines this with per-peer state for the final push priority:

```
subscription_priority(action, peer) = action.amount / response_index(peer, action.verifier)
```

Where `response_index(peer, V)` is a per-peer counter maintained by the routing module that increments each time a V-relevant block is pushed to that peer. This demotes later responses for high-activity verifiers:

| Response | Priority (amount=100) |
|----------|----------------------|
| 1st | 100 |
| 2nd | 50 |
| 10th | 10 |
| 100th | 1 |

High-value responses always punch through regardless of response index. Low-value responses to high-activity verifiers are naturally deprioritized, preventing bandwidth saturation from a single busy verifier.

---

## Claim History Lifecycle

### Addition

An entry is added when a claim resolves via `notifyClaimResolved`. The claim is appended to both the verifier-specific history and the contract-level fallback. Claims are added regardless of the claiming block's canonicality -- a peer who published a claim demonstrated capability whether or not the specific block becomes canonical.

### Pruning

Each verifier's history is bounded to `maxEntriesPerVerifier` (default 64). The contract-level fallback is bounded to `maxEntriesPerContract` (default 128). When the limit is exceeded, entries are scored by `amount * recency_weight` and the lowest-scoring entries are removed.

### No Canonical State Tracking

Unlike the previous subscription model, claim history is not affected by canonical state changes. There is no analog to `outputClaimed` / `outputUnclaimed`. This dramatically simplifies wiring -- no `resolvedClaimCache`, no canonical flip handlers.

### Cold Start

A client bootstraps into the routing network by making an initial transaction -- claiming any output to establish claim history. This does not need to be economically significant. Once a client has claim history, future blocks with matching verifier outputs are routed toward them.

---

## How Claim History Handles Each Routing Case

| Routing Case | How Claim History Handles It |
|---|---|
| Payment to pubkey P | Peers who have spent from P (claimed `{SIG, P}`) receive future payments to P. After first spend, routing is permanent. |
| Game response | Game executors who have previously claimed `{GAME, config}` outputs receive new game requests. |
| Collateral resolution | Peers who have resolved disputes (claimed collateral outputs) receive future collateral blocks needing resolution. |
| Aggregation notification | Rule 1: the aggregation claim routes back to the aggregated block's publisher. No history needed. |
| Data request response | Peers who have previously provided data (claimed `{DATA, hash}` outputs) receive new data requests. |
| New verifier (no history) | Contract-level fallback routes to any peer who has claimed the same contract type. Baseline propagation (routing module) handles the rest. |

---

## Concrete Example

### Setup

Alice publishes block B_A with outputs:
- `[0]`: `{GAME_CONTRACT, config}`, value=10 (game tick request)
- `[1]`: `{AGGREGATION_CONTRACT, ...}`, value=0 (aggregation marker)

No claim history exists for `{GAME_CONTRACT, config}`. B_A does not generate subscription send actions. It propagates via baseline propagation (routing module).

### Executor Responds

Game executor D publishes block B_resp, claiming B_A's output 0 (the game tick request). B_resp has outputs:
- `[0]`: `{GAME_CONTRACT, config}`, value=8 (next state)
- `[1]`: `{SIGNATURE_CONTRACT, D.pubkey}`, value=2 (fee)

**Rule 1** fires when B_resp's claim on B_A resolves:
- Emit `SendAction(block=B_resp, trigger=B_A, verifier={GAME_CONTRACT, config}, amount=10)` -- routes the response back to Alice.
- Add B_resp to `claimHistory[{GAME_CONTRACT, config}]`.
- Backfill: query UTXO for unclaimed `{GAME_CONTRACT, config}` outputs. If Bob also has an unclaimed game request B_B, emit `SendAction(block=B_B, trigger=B_resp, verifier={GAME_CONTRACT, config}, amount=...)` -- routes Bob's request to the executor.

### Second Request

Bob publishes block B_B with output `[0]`: `{GAME_CONTRACT, config}`, value=8.

**Rule 2** fires when B_B is received:
- `claimHistory[{GAME_CONTRACT, config}]` contains `{B_resp, 10, ...}`.
- Emit `SendAction(block=B_B, trigger=B_resp, verifier={GAME_CONTRACT, config}, amount=10)` -- routes Bob's request toward the executor D.

### Key Property

Requests route to providers, not to other requesters. Alice's game request goes to the executor D (who has claim history). Bob's request also goes to D. Alice and Bob don't receive each other's requests -- only the peer who can serve them does.

### Aggregation

Aggregator E claims B_A's aggregation marker (output 1):
- **Rule 1**: Emit `SendAction(block=E, trigger=B_A, verifier={AGGREGATION_CONTRACT, ...}, amount=0)` -- notifies Alice that B_A was aggregated.
- E's own aggregation marker has a unique verifier. Future aggregation of E follows the same pattern.

---

## Future Extensions

**Fraud broadcast.** The claim history model routes blocks to interested parties, but some blocks -- particularly AGAINST collateral challenges -- may need to reach peers who have no existing claim history. When a peer litigates against a block, the challenge should propagate as widely as possible so that other verifiers can pile on (the voting cascade described in [trust.md](trust.md)). This likely requires a separate **broadcast action** alongside the claim-history-based send action. The exact mechanism is deferred until the collateral resolution system is fully specified.

**Unspentness proofs.** Claim masks are currently stored as sorted index arrays. In a future revision, these will be replaced with merkle trees, enabling compact proofs that a specific output is NOT claimed at a given aggregation level.

**Cross-network discovery.** The current design relies on gossip propagation to spread V-relevant blocks to all V-interested peers. In large networks, this may be slow for rare verifiers. A future extension could map verifiers to synchronization points in the network (an implicit DHT), ensuring V-relevant blocks converge at a known location regardless of gossip path length.

---

## Interaction with Other Modules

**Routing module**: Receives send actions, maps triggers to peers, manages delivery. The routing module maintains `receivedFirst` sets that map trigger blocks to peers, enabling the gossip module's send actions to reach the correct network destinations. See [routing module](routing.md).

**Output claims module**: Fires `onResolution` when claims resolve. This is the primary input to the gossip module -- each resolution triggers Rule 1 (route claim back, update history, backfill).

**Consensus module**: Provides canonical view for the UTXO index, which the gossip module queries during backfill. The gossip module does not directly consume canonical state changes.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| New blocks | Network / local creation | Blocks to evaluate outputs against claim history (Rule 2) |
| Claim resolutions | Output claims module (via `notifyClaimResolved`) | Resolved claims trigger Rule 1, history update, and backfill |
| UTXO index queries | UTXO index (via provider) | Unclaimed outputs for backfill when new claim history entries appear |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Send actions | Routing module | `(block, trigger, verifier, amount)` tuples for delivery |

### Invariants

1. **Claim history monotonicity**: Entries are only added, never removed. Pruning reduces the number of entries per verifier but does not retroactively delete historical data.
2. **Completeness**: Every new block's outputs are checked against the full claim history index. No match is missed.
3. **Backfill correctness**: When a new claim history entry appears for verifier V, all existing unclaimed V-outputs are routed toward the new claimer.
4. **Self-claim exclusion**: Self-claimed outputs never generate claim history entries or send actions.

### Bootstrapping claim history (cold start)

Claim-history routing is self-perpetuating in a mature network -- every new claim populates more history -- but it has no built-in cold-start mechanism. In a fresh network, no node has observed any claims yet, so `claimHistory` and `contractFallback` are empty and new request outputs have nowhere to be routed.

Two approaches fill this gap:

1. **Capability-seed blocks + manual relay.** A node that can resolve contract C publishes a block that self-claims a C-output, then ships the block directly to peers via a non-gossip channel. Each recipient records the block in the sender's `receivedFirst` and processes its self-claim through `notifyClaimResolved`, populating `contractFallback[C]` with an entry whose trigger points along the relay path. Subsequent C-outputs then route along the seeded path. `Scaffold.sendBlockToPeer(hash, peerId)` exposes this as a tool for demos and tests that need to simulate a warm network.

2. **Contract-interest advertisement via peerInfo (future work).** Peers announce contracts they can execute as part of peerInfo. The gossip module uses this as a relevance signal for routing, equivalent to claim history with a tunable decay. TODO.md tracks this as the "Request Routing" open problem; it is the planned long-term solution.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/node/GossipModule.ts`](../../src/node/GossipModule.ts) | Claim history index, send action generation, backfill, pruning |
| [`src/node/GossipService.ts`](../../src/node/GossipService.ts) | Wired adapter using concrete `Block` type and UTXO index |
