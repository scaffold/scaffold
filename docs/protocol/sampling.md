# Sampling

Sampling is how the protocol converts declared work into verified work. Without sampling, a block could claim arbitrary weight and the network would have no way to distinguish legitimate work from fabrication.

The protocol uses two sampling processes:

1. **Weight sampling** (this document): Probes trees proportionally to aggregation incentive, which approximates verification cost. Determines tree weight through a statistical weight factor. This is the primary mechanism by which blocks earn consensus influence.

2. **Throughput sampling** (see [deception.md](deception.md)): Probes trees proportionally to total throughput. Used to detect invalid blocks and trigger challenges. Covered separately because it serves a different purpose (fraud detection vs. weight determination).

---

## Block Probe State

Each block maintains a local probe state tracking the history and outcomes of probes that have passed through it:

```
BlockProbeState {
    aggregateWeights:  number[]     // verification cost per aggregate subtree
    selfWeight:        number       // this block's own verification cost
    queries:           number[]     // probe log: -1 = self, i = aggregate index
    selfVerified:      boolean      // whether this block passed verification
}
```

**aggregateWeights** are the aggregation incentives of each aggregate subtree -- the total verification cost of the subtree rooted at each aggregate. These determine the probability of a probe descending into each subtree.

**selfWeight** is the block's own verification cost, excluding its subtrees. Ideally this is derived from the aggregation incentive (the block's incentive minus the sum of its aggregates' incentives), preserving the self-correcting market-pricing property. For now, it is stored as a direct property. The exact derivation is an open question.

**queries** is an append-only log recording where each probe descended. Each entry is either -1 (the block itself was the terminal) or an index into the aggregates array. The length of this array is the total probe count at this block.

**selfVerified** is set to true when the block's own computation has been verified: all refs and anchors fetched, and the verifier contract executed and accepted.

---

## Probe Descent

A probe starts at some initial block and randomly descends through the aggregation tree, choosing a path proportionally to weight at each branch point:

```
function initProbe(block):
    state = getProbeState(block)
    totalWeight = state.selfWeight + sum(state.aggregateWeights)

    probeAt = random() * totalWeight
    for i in 0..state.aggregateWeights.length:
        w = state.aggregateWeights[i]
        if probeAt < w:
            // Probe descends into aggregate i
            state.queries.push(i)

            // Ensure the aggregate has at least as many probes as we've sent it
            requestedCount = count(state.queries, q => q == i)
            if getProbeState(block.aggregates[i]).queries.length < requestedCount:
                initProbe(block.aggregates[i])

            return
        probeAt -= w

    // Self-weight was selected: this block is the terminal
    state.queries.push(-1)
    // Launch verification of this block (async)
```

At each branch point, the block's own weight and all aggregate subtree weights compete. When the block's own weight is selected, the probe has hit a **terminal** -- the block itself must be verified. This can happen even when the block has aggregated subtrees, because selfWeight is always one of the options.

### Terminal Verification

When a probe hits a terminal, the block is verified:

1. Request all refs and anchors (fetch any missing data).
2. Run the verifier contract on the block.
3. If verification succeeds, set `selfVerified = true`.

### Propagation Boundary

Verification results propagate up to the **initial query block** (the block where `initProbe` was first called) but **not past it**. From a parent's perspective, a probe it didn't initiate is not a true random sample -- the child chose its own descent path, which may not be representative of the parent's weight distribution.

**Reuse exception**: When a parent probes a child block that has already accumulated results from earlier probes, the child's existing results can be reused via the `limit` parameter in `countVerifications`. The parent DID choose this child proportionally to weight, so the child's results are valid samples from the parent's perspective, up to the number of probes the parent actually sent.

### Missing Blocks

If a probe descends and hits a block that hasn't been received, the probe counts as a **pending failure**. The query counter increments (increasing the denominator of the weight factor), but the response counter does not increment until the block is received and verified.

This naturally penalizes trees with missing data -- their weight factor drops while blocks are unavailable. You shouldn't trust work you can't verify.

When a missing block arrives and is subsequently verified, the weight factor recovers.

---

## Weight Factor

The weight factor is the ratio of verified terminals to total probes at a given block:

```
weight_factor(block) = countVerifications(block, state, state.queries.length)
                       / state.queries.length
```

When `queries.length = 0`, the weight factor is 0. This is the pessimistic default -- unverified blocks contribute no weight to consensus.

A tree's verified weight is:

```
tree_weight = aggregation_incentive * weight_factor
```

This feeds into the consensus module as the block's verified weight for conflict resolution.

### Counting Verifications

The `countVerifications` function recursively counts verified terminals, bounded by a limit parameter:

```
function countVerifications(block, state, limit):
    // Only consider the first `limit` queries at this level
    queries = state.queries.slice(0, limit)
    verifications = 0

    for i in 0..block.aggregates.length:
        probeCount = count(queries, q => q == i)
        if probeCount == 0: continue
        verifications += countVerifications(
            block.aggregates[i],
            getProbeState(block.aggregates[i]),
            probeCount
        )

    if state.selfVerified:
        verifications += count(queries, q => q == -1)

    return verifications
```

The **limit** parameter is the key mechanism for safe result reuse. When a parent probes a child N times, only N of the child's results count toward the parent's weight factor. This prevents a heavily-probed subtree from disproportionately inflating its parent's confidence.

**Example**: Block A probes aggregate B twice. B has been independently probed 100 times with 90 successes. From A's perspective, B contributes at most 2 verifications (limited to how many times A actually probed B). A's weight factor is not inflated by B's extensive independent verification.

---

## Probe Scheduling

Given a budget of one probe, which tree should be probed? The optimal choice maximizes the expected absolute change in tree weight -- the **expected weight swing**.

### Expected Weight Swing

The expected signed weight change from a probe is zero (the ratio estimator is a martingale -- one more sample doesn't change the expected value). But the expected **absolute** change -- how much the weight moves in either direction -- is computable and represents the information value of one probe.

Model the true validity fraction as `p ~ Beta(r + 1, q - r + 1)` (uniform prior, Bayesian update from observed probes), where `r` = responses (verified count), `q` = queries (total probes), and `I` = aggregation incentive. The expected absolute weight change is:

```
swing(T) = 2I(r + 1)(q - r + 1) / [(q + 2)^2(q + 3)]
```

**Derivation**: Compute the Bayesian update under success (prob `alpha / (alpha + beta)`) and failure (prob `beta / (alpha + beta)`), take the absolute weight change in each case, and weight by their probabilities. The result simplifies to `2I * alpha * beta / [(alpha + beta)^2 * (alpha + beta + 1)]` where `alpha = r + 1` and `beta = q - r + 1`.

| State | swing / I |
|-------|-----------|
| q=0, r=0 (unknown) | 1/6 |
| q=1, r=1 (one success) | 1/18 |
| q=10, r=5 (uncertain) | 36/1872 |
| q=10, r=10 (well-verified) | 11/1872 |
| q=10, r=0 (likely fraud) | 11/1872 |

Unknown trees get maximum priority per unit of incentive. Maximum uncertainty (r = q/2) maximizes swing. Well-characterized trees (high or low weight factor) have minimal swing -- we already know enough about them.

### Expected Canonicality Change

For trees in a conflict, priority should reflect the expected change to the canonical set from one probe. This depends on three factors:

1. **Swing**: How much could the tree's weight change? (from the formula above)
2. **Gap**: How close is the conflict? A small gap means one probe could flip the winner.
3. **Contested weight**: How much canonical weight is at stake? Two large trees flipping is a bigger deal than two small ones.

One probe changes T's weight by approximately `swing`. The probability of flipping the conflict winner is roughly `swing / gap`. If a flip occurs, the canonical set changes by `contested_weight = w_T + w_R` (one tree enters canonical, the other leaves).

The expected canonicality change:

```
E[DC] = swing * contested_weight / max(gap, epsilon)
```

Where:
- `contested_weight = w_T + w_R` (sum of both trees' weights)
- `gap = |w_T - w_R|` (absolute weight difference)
- `epsilon` prevents division by zero when the gap is negligible

### Full Priority Formula

```
priority(T) = swing(T)                                              [no conflict]
priority(T) = swing(T) * contested_weight / max(gap, epsilon)      [in conflict]
```

Two large trees (w=1000 each) with a tiny gap (1) produce `swing * 2000` -- very high priority. The same trees with a large gap (500) produce `swing * 4` -- much lower. The tree with the highest priority is selected for probing.

### Pending Backpressure

Each in-flight probe increments the query counter but not the response counter. This naturally limits concurrent probes: launching too many probes on a single tree temporarily deflates its weight factor, which reduces the tree's consensus influence while probes are outstanding.

The optimal concurrency emerges from the priority formula: each additional pending probe increases `q`, which reduces the swing, making other trees relatively more attractive to probe. No explicit concurrency limit is needed.

---

## Emergent Behaviors

The probe mechanism produces desirable behaviors without explicit modeling:

**Recency preference.** New trees (q=0) get maximum priority per unit of incentive. Old, well-verified trees have high `q` and high weight factor. No explicit time parameter is needed -- recency emerges from the information structure.

**Fraud deprioritization.** Trees with consistent failures accumulate high `q` with low `r`. Their weight factor stays near zero (they contribute no consensus weight), and their swing is minimal (we already know they're fraudulent). They fall off naturally without a blacklist.

**Natural concurrency limit.** Pending probes deflate the weight factor and reduce swing, making it increasingly unattractive to launch more probes on the same tree. The system self-regulates to an efficient number of concurrent probes.

**Convergence.** As probes accumulate, the weight factor converges to the true fraction of valid work (law of large numbers). The rate of convergence is proportional to sampling frequency, which is proportional to incentive.

**Subtree isolation.** The limit parameter in `countVerifications` ensures that fraud in one subtree doesn't inflate confidence in sibling subtrees. Each subtree's contribution to its parent's weight factor is bounded by how many probes the parent actually sent to it.

---

## Concrete Example

### Setup

Block G (genesis) has two aggregate subtrees, each containing further structure:

```
G (selfWeight: 10)
  +-- A (selfWeight: 5, subtreeWeight: 40)
  |     +-- A1 (selfWeight: 15)
  |     +-- A2 (selfWeight: 20)
  +-- B (selfWeight: 8, subtreeWeight: 30)
        +-- B1 (selfWeight: 22)
```

G's total weight = 10 + 40 + 30 = 80.

Probe probability at G: A gets 40/80 = 50%, B gets 30/80 = 37.5%, self gets 10/80 = 12.5%.

### After 8 Probes

Suppose 8 probes are sent to G. By the random descent, approximately:
- 4 go to A (2 hit A1, 1 hits A2, 1 hits A's self)
- 3 go to B (2 hit B1, 1 hits B's self)
- 1 hits G's self

All terminals verify successfully.

G's state: `queries = [0, 0, 1, 0, -1, 1, 1, 0]`, where 0 = aggregate A, 1 = aggregate B, -1 = self.

```
countVerifications(G, state, 8):
  A probed 4 times: countVerifications(A, A_state, 4) = 4 (all verified)
  B probed 3 times: countVerifications(B, B_state, 3) = 3 (all verified)
  self: 1 query, selfVerified = true: 1
  total = 8

weight_factor(G) = 8 / 8 = 1.0
tree_weight = 80 * 1.0 = 80
```

### One Subtree Fails

Now suppose A2 fails verification. After 10 total probes:

G's state: queries has 5 to A, 3 to B, 2 to self. A's state: 2 to A1, 2 to A2, 1 to self.

```
countVerifications(A, A_state, 5):
  A1 probed 2 times, both verified: 2
  A2 probed 2 times, NOT verified: 0
  self: 1 query, verified: 1
  total = 3

countVerifications(G, state, 10):
  A: 3 (out of 5 probes)
  B: 3 (out of 3 probes, all verified)
  self: 2 (selfVerified = true)
  total = 8

weight_factor(G) = 8 / 10 = 0.8
tree_weight = 80 * 0.8 = 64
```

The fraudulent subtree A2 has reduced G's weight factor from 1.0 to 0.8. As more probes hit A2, the weight factor will converge toward 0.75 (A2's 20 out of 80 total weight is invalid, so 60/80 = 0.75 of the tree is real).

---

## Throughput Sampling

Weight sampling determines *how much* of a tree's work is real. A separate process -- throughput sampling -- determines *whether specific blocks are invalid*. It descends proportionally to total throughput rather than verification cost, and is the mechanism by which invalid blocks are detected with high probability.

Throughput sampling is specified in [deception.md](deception.md) because it is intimately connected to the self-flagging mechanism and the deception equilibrium.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Block structure | Block creation module | Aggregates, self weight, subtree weights |
| Aggregation incentive | Aggregation module | Total verification cost per tree |
| Verification results | Verification module | Success/failure for terminal blocks |
| Conflict weight gaps | Consensus module | For proximity multiplier in scheduling |
| Block availability | Network / Gossip | Whether blocks can be fetched for verification |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Weight factor per block | Consensus module | Scales declared weight to verified weight |
| Probe requests | Verification module | Which block to verify next (terminal from descent) |
| Scheduling priority | Verification module | Which tree to probe next |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/ProbeModule.ts`](../../src/core/ProbeModule.ts) | Core probe logic: BlockProbeState, initProbe, countVerifications, weight factor, scheduling |
| [`src/core/ProbeService.ts`](../../src/core/ProbeService.ts) | Adapter wiring ProbeModule to BlockStore and ConsensusService |
