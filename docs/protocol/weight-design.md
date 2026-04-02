# Weight System Design Space

This document maps the design decisions for how block weight is derived, propagated, and verified. It captures the tradeoffs, attack analysis, and reasoning journey that led to the current design. The [weight module](weight.md) contains the current specification.

---

## Resolution Summary

The weight system converged on a surprisingly simple design: **weight = verification cost, paid for by the aggregation fee**. This emerged from recognizing that the deception equilibrium (see [deception.md](deception.md)) already prices block inclusion at verification cost. Many mechanisms that were considered necessary -- contract whitelisting, work formulas, cheapest-claimer bias -- turned out to be solving problems that the aggregation fee inherently solves.

The key insight: the aggregation fee f ~= v is an irreversible cost proportional to verification cost, paid by every block regardless of contract type. Weight = v, cost = v. No amplification is possible because each unit of weight requires a corresponding unit of payment.

---

## Foundation: Sampling & Verification

Without verification that a block represents real work, a client's view of the network is indistinguishable from a cheaply-created sybil network claiming work it didn't do. Sampling is a prerequisite for consensus.

The sampling module descends proportionally to declared throughput (not block count), ensuring detection probability scales with impact. A subtree claiming 50% of declared throughput receives ~50% of sampling effort:

- High-impact inflation is very likely detected.
- Low-impact inflation may slip through but doesn't matter.
- An attacker cannot reduce detection probability without reducing the inflation's impact.

### Two Sampling Metrics

A critical observation: sampling uses two distinct metrics for two distinct purposes.

**Throughput** (deterministic): Total value of inputs claimed. Computable from the block's I/O. This is the descent metric -- it tells samplers where to look. It is structural and universally agreed upon.

**Verification cost** (fuzzy): Actual computational cost of re-executing the verifier contracts. This is the weight metric -- it tells the network what the work was worth. It is measured independently by each client.

Sampling compares the two:

```
effective_weight = throughput * (verification_cost / throughput) = verification_cost
```

The throughput cancels. Effective weight equals verification cost. This clean separation means:
- The block doesn't need to "declare" its weight -- the network measures it.
- No formula over I/O is needed to derive weight.
- Gaming throughput (cycling large values) doesn't affect effective weight.

---

## The Aggregation Fee Insight

The deception equilibrium (see [deception.md](deception.md)) establishes that the aggregation fee converges to the verification cost:

```
f ~= v    (competitive equilibrium among aggregators)
```

This fee is:
- **Irreversible**: Permanently transferred from publisher to aggregator. Not locked capital (which is returned).
- **Market-priced**: Aggregator competition drives fees to marginal cost = verification cost.
- **Universal**: Every block pays this regardless of contract type.

This makes the aggregation fee a natural proof of weight. Each block's consensus influence costs exactly its verification cost. No additional mechanism is needed to price weight correctly.

### Problems Solved by the Aggregation Fee

**Asymmetric difficulty (previously required a whitelist)**: An attacker with a generation shortcut still pays f ~= v per block. Their advantage is at most ~2x capital efficiency (they skip generation cost v, paying only the fee v, while honest participants pay ~2v). This bounded advantage is acceptable and comparable to hardware advantages in any computational system.

**Cycling (previously required the net formula)**: Each cycle of capital through a contract pays f ~= v. The capital is recycled but the fee is not. Weight per cycle = v = cost per cycle. Cycling is indistinguishable from legitimate computation.

**Fee inflation (previously required cheapest-claimer)**: Fees are set by market competition among aggregators, not declared by block creators. No consensus mechanism needed for fee compression.

**Duplication (tree copying)**: Each duplicate block requires its own aggregation fee. N copies = N * v in fees. Weight = N * v = cost. No amplification.

**Capital dominance (previously required net formula)**: Weight = verification cost, which doesn't scale with input values. Processing 1M through a trivial contract earns the same weight as processing 1.

---

## Design Choices: Analysis and Resolution

### Choice 1: Generation vs. Verification Cost

**Generation cost**: What it cost the block creator to produce the result. Conceptually "correct" but **unobservable** -- you can't know someone's true generation cost.

**Verification cost**: What it costs a verifier to re-execute and check the result. **Observable and reproducible** by any node.

For deterministic WASM contracts (the common case), verification = re-execution, so generation cost = verification cost. The distinction is moot.

For search/optimization problems (find x satisfying P(x)), generation > verification. Weight based on verification cost undercounts the work, but conservatively.

For ZK proofs, generation >> verification. Weight based on verification cost significantly undercounts. ZK blocks earn weight proportional to their (cheap) verification cost, not their (expensive) generation cost.

**Resolution**: Verification cost. It is the only ground truth the network has. The aggregation fee naturally prices at verification cost. For contracts where generation >> verification (ZK), this means lower weight per unit of generation effort, but proportional weight per unit of verification cost imposed on the network.

### Choice 2: Derived from I/O vs. Declared Property

**I/O-derived**: `declaredWeight` is computed from the block's inputs and outputs. Deterministic, structurally verifiable, no separate verification needed.

**Declared property**: The block declares a weight, verified by sampling. Flexible (can incorporate instruction count, execution time) but opens a gaming window until sampling corrects.

**Resolution**: Neither, in the traditional sense. The block's throughput (I/O-derived, deterministic) serves as the structural metric for sampling descent and weight vector composition. The actual effective weight is determined by sampling (verification cost). There is no `declaredWeight` that needs to be trusted -- weight emerges from measurement.

Aggregation blocks are regular contracts (generator + verifier pairs), not special protocol constructs. They claim outputs and produce outputs like any other block, earning weight through the same mechanism.

### Choice 3: Work Formula

Previously, significant analysis went into choosing between:

- **Gross throughput**: `sum(whitelisted inputs)`. Problem: capital dominance and cycling.
- **Net consumption**: `sum(whitelisted inputs) - sum(whitelisted outputs)`. Prevents cycling but makes weight = fees, not computation. Requires cheapest-claimer to compress fees.

**Resolution**: No formula needed. Throughput is the structural metric (for sampling descent). Verification cost is the effective weight (measured by sampling). The aggregation fee prevents cycling and capital dominance without any formula. See "Problems Solved by the Aggregation Fee" above.

### Choice 4: Cheapest-Claimer Bias

The mechanism `conflict_score = D - W * c` was designed to penalize high-fee blocks in conflict resolution, creating a reverse auction that drives fees to marginal cost.

**Resolution**: Not needed. Fees don't affect effective weight (which is verification cost, not fee). Fee compression happens through market competition (clients choose cheaper providers), not through the consensus mechanism. Separating fee compression (market concern) from conflict resolution (consensus concern) is cleaner.

#### Historical Attack Analysis

The cheapest-claimer mechanism had a subtle vulnerability (Fee Zeroing): a block taking zero fee (W = 0) would have conflict score D - 0 = D, dominating any block with positive W. However, this attack doesn't actually work because whitelisted outputs (W = 0 requires producing all whitelisted output) are claimable by anyone -- the attacker has no exclusive extraction path.

With the aggregation-fee-based design, this entire class of concerns is eliminated. Conflict resolution is pure effective weight (verified computation + descendant weight), with no fee-based modifiers.

### Choice 5: Excluding Losing Claimers from Work

Should losing blocks' weight be excluded from ancestor weight to keep the weight "clean"?

**Resolution**: No. Excluding losers creates a dependency cycle: weight determines conflict winners, but conflict winners determine weight. The current design uses **canonical-independent weight** -- all descendants count regardless of conflict outcomes. This gives a clean two-pass algorithm: compute weight first, resolve conflicts second.

The cost: a losing block's weight "inflates" its ancestor's descendant weight. But this inflation is bounded (the loser paid real cost for that weight via the aggregation fee) and doesn't create a gaming vector.

### Choice 6: Ancestor Weight in Conflict Resolution

Should a block's conflict score include the weight of its ancestors (the chain above it)?

**Resolution**: No. Descendant weight already provides chain preference through natural dynamics: rational participants build on the heaviest chain, making it heavier, attracting more work. Ancestor weight adds complexity and centralization pressure (established chains become harder to overtake) without clear security benefit.

### Choice 7: Weight Propagation

Weight flows toward anchors and aggregated children. Not toward claims (which would double-count). O(log N) with balanced aggregation trees.

**Resolution**: This follows directly from canonical-independent weight and the chain-of-trees structure. Not really a choice -- it's determined by the other decisions.

### Choice 8: Relative vs. Absolute Subtree Weights

**Resolution**: Absolute throughput values, adjusted by each client's sampling results. Absolute values provide a shared reference point for sampling descent. Each client's effective weight may differ (different sampling results), converging as more samples are taken.

### Choice 9: Non-Whitelisted Contract Weight

Previously, only whitelisted contracts could earn weight, with burn/stake considered as a supplement for non-whitelisted contracts.

**Resolution**: Moot. There is no whitelist. All contracts earn weight proportional to their verification cost, paid for by the aggregation fee. The burn/stake supplement is unnecessary.

---

## Attack Analysis

### Asymmetric Difficulty (Shortcut Attack)

**Attack**: Deploy a contract cheap for the author, expensive to verify. Produce many blocks cheaply.

**Defense**: Each block pays f ~= v (the verification cost). The shortcut reduces generation cost but not the fee. Maximum advantage: ~2x capital efficiency. The attacker produces weight proportional to v * (capital / v) = capital. Same capital-to-weight ratio as everyone else, just faster block production (which is bounded by capital for fees, not computation speed).

### Cycling / Wash Trading

**Attack**: Cycle the same capital through a contract repeatedly, earning weight each cycle.

**Defense**: Each cycle pays f ~= v. Weight per cycle = v = cost per cycle. Cycling is proof-of-work: real computation, real cost. Indistinguishable from legitimate use because a sybil client cycling contracts looks identical to a real client requesting computation.

### Private Fork with Inflated Fees

**Attack**: Build a private fork, take large fees (no competition), publish after accumulating weight.

**Defense**: Sampling compares verification cost to throughput. Inflated fees increase throughput but not verification cost. The ratio (verification_cost / throughput) drops, scaling down the fork's effective weight. Work-proportional sampling descent ensures inflated subtrees receive proportional scrutiny.

### Tree Duplication

**Attack**: Duplicate a tree of computation by re-signing every block and re-aggregating.

**Defense**: Each duplicate block requires its own aggregation fee (f ~= v) and collateral (M * C). Weight = N * v, cost = N * v. No amplification. The aggregation fee is the proof-of-cost that cannot be reused even when computation is reused.

Additionally, duplicated blocks that claim the same outputs as the originals create conflicts -- only one copy can be canonical. If claims differ, the computation must differ (different inputs to deterministic contracts), requiring genuine re-execution.

### Capital Dominance / Proof-of-Stake Dynamics

**Concern**: Weight is ultimately bounded by capital (for aggregation fees and collateral). Is this PoS in disguise?

**Assessment**: The system is a hybrid. Verification cost v determines weight per block (the computational component). Capital determines how many blocks can be produced (the economic component). For expensive contracts (high v), computation dominates. For cheap contracts (low v), capital dominates but weight is proportionally low.

This is acceptable: capital bounds total participation, computation determines the weight earned per unit of participation. Neither component alone determines consensus influence.

### Trivial Contract Spam

**Attack**: Produce millions of blocks on trivially cheap contracts.

**Defense**: Trivial contract => v ~= 0 => weight ~= 0 per block. Each block still requires collateral M * C. The attacker pays significant capital for negligible weight. Self-defeating.

### ZK Proof Asymmetry

**Concern**: ZK contracts have generation >> verification. ZK blocks earn weight proportional to (cheap) verification cost, not (expensive) generation cost.

**Assessment**: This is by design. Weight reflects the burden on the verification layer, not the generator's effort. ZK blocks earn lower weight per generation-dollar, but proportional weight per verification-dollar. If ZK-based consensus weight is desired in the future, the sampling module could incorporate per-contract verification-to-generation ratios (declared in contract metadata), but this adds complexity and is deferred.

---

## Legacy Context

The prior implementation (`legacy2/BlockMetrics.ts`) used a formula-based approach:

```
selfWork = 1 + sum(free-market inputs) - sum(free-market outputs)
```

Where "free-market" was a contract whitelist filter (`frontierHash`). This measured net economic consumption on whitelisted contracts. The formula included:
- A base `+1` giving every block minimum weight
- Separate `freeMarketOutput` tracking for conflict scores
- `conservativeSelfWork` (capping self-work by conflicting blocks' self-work)
- `claimWeightBoost` (collateral-based conflict score supplement)
- `ancestorWeight` and `descendantWeight` components

The current design eliminates all of these in favor of the aggregation-fee-based model. The legacy formula's strengths (preventing cycling, measuring economic demand) are subsumed by the aggregation fee. Its weaknesses (requiring a whitelist, entangling fees with consensus, complex multi-component scoring) are avoided entirely.

The key formulas that enabled cycle-free O(log N) weight propagation in the legacy system remain relevant to the weight vector mechanics (see [weight.md](weight.md) Weight Vector section), even though the weight derivation itself is fundamentally different.

---

## Open Questions

1. **Sampling convergence speed**: How quickly do different clients' effective weights converge? If convergence is slow, clients may disagree on conflict outcomes during the convergence window. The pessimistic-pending model (unverified = zero weight) provides safety but may delay consensus.

2. **Verification cost measurement**: How is verification cost measured in practice? Wall-clock time varies by hardware. Instruction counting requires WASM metering. The measurement doesn't need to be exact (sampling is statistical), but it needs to be consistent enough across clients for effective weights to converge.

3. **Aggregation economics**: Is the aggregation fee sufficient to incentivize timely aggregation, especially as subtrees grow and aggregation becomes more computationally expensive? The fee market should self-correct (more expensive aggregation = higher fees = more aggregator incentive), but the dynamics need empirical validation.

4. **The ~2x shortcut advantage**: For most contracts (verification ~= generation), there is no advantage. For contracts with asymmetric generation cost, the maximum advantage is ~2x. Is this acceptable in all scenarios, or are there cases where even 2x creates problematic dynamics?

5. **Bootstrapping**: Early in the network's life, total weight is low and the token has uncertain value. The aggregation fee is cheap, making weight easy to acquire. Standard bootstrapping trust (initial participant set, checkpoints) may be needed.

---

## Cross-References

- [weight.md](weight.md) -- Current specification
- [sampling.md](sampling.md) -- Statistical model for weight verification
- [consensus.md](consensus.md) -- How weight is used for conflict resolution
- [block-creation.md](block-creation.md) -- Weight vector construction
- [dag.md](dag.md) -- Tree balancing and propagation structure
- [deception.md](deception.md) -- Aggregation fee derivation (f ~= v)
- [trust.md](trust.md) -- Collateral structure
