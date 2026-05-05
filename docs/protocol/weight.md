# Weight Derivation

This document specifies how block weight is determined -- how blocks earn consensus influence through verified computation. The weight vector's role in consensus is specified in the [consensus module](consensus.md); this document focuses on where the numbers come from.

For the design exploration and attack analysis behind these decisions, see [weight-design.md](weight-design.md).

---

## Core Principle: Weight = Verified Computation

A block's effective weight is its **verification cost** -- the computational cost a verifier incurs when re-executing the block's contracts. This is the only cost the network can independently confirm.

Weight derivation relies on two distinct metrics that serve different purposes:

**Throughput** (deterministic, structural): The total value of inputs claimed by the block. Any node can compute this from the block's I/O. Used for sampling descent (deciding which subtrees to probe) and for composing the weight vector in aggregation blocks. Throughput is the structural scaffolding that tells samplers **where to look**.

**Verification cost** (fuzzy, measured): The actual computational cost of re-executing the block's contract verifiers. Measured independently by each client during sampling. This is the ground truth for weight -- it tells the network **what the work was actually worth**.

### How They Compose

Sampling compares verification cost to throughput:

```
effective_weight = tree_throughput * (sum(verification_cost_i) / sum(throughput_i))
```

Where the sums are over sampled blocks. The throughput cancels out:

```
effective_weight ~= total_verification_cost
```

Effective weight equals total verification cost across the tree. Throughput is the descent metric that gets corrected away by sampling.

---

## The Aggregation Fee as Proof of Weight

Every block must be aggregated to participate in consensus. Aggregation transfers risk from the publisher to the aggregator, who posts collateral (see [trust.md](trust.md)). The publisher pays an aggregation fee for this service.

The aggregation fee is market-priced by aggregator competition at the verification cost:

```
f ~= v    (where v = verification cost per block)
```

See [deception.md](deception.md) for the game-theoretic derivation.

This fee is the **proof of weight**:

- **Irreversible cost**: The fee is permanently transferred from publisher to aggregator. Unlike collateral (which is returned if the block is valid), the fee is a genuine, non-recoverable cost.
- **Market-priced at verification cost**: Aggregators compete, driving fees to marginal cost. Marginal cost = verification cost (the aggregator's primary expense is running the verifier).
- **"Useful burn"**: The value goes to aggregators who perform real verification work. It is not wasted -- it funds the verification layer.
- **Universal**: Every block on every contract pays this cost. Weight = v, cost = v, always.

### Why No Whitelist Is Needed

A contract whitelist was previously considered necessary to prevent asymmetric-difficulty attacks (contracts cheap for the author, expensive for others). The aggregation fee eliminates this concern:

1. **Every block pays f ~= v regardless of contract.** The attacker's generation shortcut doesn't reduce the aggregation fee.
2. **Weight = v regardless of contract.** Weight is proportional to verification cost, which the attacker paid for.
3. **Bounded shortcut advantage.** An honest participant pays generation + fee (~= 2v, since verification ~= generation for most contracts). An attacker with a shortcut pays only fee (~= v). At most ~2x capital efficiency advantage.
4. **Trivial contracts earn nothing.** A contract with negligible verification cost produces negligible weight.

Any contract can earn weight. No governance bottleneck around contract approval.

### Why No Work Formula Is Needed

Previous designs derived `declaredWeight` from a formula over the block's I/O (e.g., net whitelisted consumption: whitelisted inputs - whitelisted outputs). This was needed to prevent cycling (reusing capital to earn unlimited weight) and capital dominance (weight scaling with value rather than computation).

The aggregation fee resolves both:

- **Cycling**: Each cycle pays f ~= v. Capital is recycled but the fee is not. Weight per cycle = v, cost per cycle = v. Cycling is indistinguishable from legitimate computation -- each cycle requires real contract execution and pays real verification cost.
- **Capital dominance**: Weight = verification cost, which doesn't scale with the value of inputs. Processing 1M through a trivial contract earns the same weight as processing 1 through the same contract (verification cost is the same).

### Why No Cheapest-Claimer Is Needed

The cheapest-claimer mechanism (conflict_score = D - W * c) was designed to drive fees toward marginal cost through conflict resolution. With aggregation-fee-based weight, fees are irrelevant to consensus -- they don't affect the block's effective weight or conflict score. Fee compression happens through normal market competition (clients choose cheaper providers). The consensus layer measures computation; the fee market determines pricing. These are separate concerns.

---

## Duplication Defense

An attacker might duplicate a tree of computation: re-sign every block, re-aggregate, producing N copies that appear as independent work.

Each copy independently requires:
- **Its own aggregation fee**: f ~= v per block per copy
- **Its own collateral**: M * C per block per copy (temporary, returned if valid)

Weight earned from N copies = N * v. Cost = N * v (fees). No amplification -- the attacker pays exactly as much as they earn. The aggregation fee acts as a proof-of-cost that cannot be reused even if the computation was.

---

## Weight Vector

The weight vector is structurally derived from throughput values:

- **Leaf block**: `weight = [throughput, 0, 0, ...]` where throughput = sum of input values claimed.
- **Aggregation block**: Composes subtrees' weight vectors, attributing throughput to anchor chain depths.

Clients independently scale these vectors by their sampling results (verification_cost / throughput ratios). The declared weight vector is structural scaffolding; sampling determines effective weight.

### Canonical-Independent Weight

Effective weight includes ALL descendants' verified weight, regardless of conflict outcomes. This avoids a dependency cycle: if weight depended on conflict outcomes and conflicts depended on weight, the system would have no well-defined state. Computing weight first and resolving conflicts second gives a clean two-pass algorithm. See [weight-design.md](weight-design.md) Design Choice 5 for the full analysis.

### O(log N) Propagation

With balanced aggregation trees (enforced by the weight-ratio constraint), weight propagation from a new leaf to the anchor chain is O(log N). Without balancing, a degenerate tree could require O(N) depth.

The propagation rule itself -- how `selfWeight` and `weightVector` are combined into `derivedWeightVector` and how `descendantWeight(X)` is computed for any block (including drafts as phantom nodes) -- is specified in [weight-propagation.md](weight-propagation.md). It is canonical-independent (uses max over neighbours, never sum), so there is no circularity between consensus's canonicality decision and weight.

---

## Interaction with Other Modules

**Consensus module**: Uses the weight vector for conflict resolution. Effective weight = verified weight (from sampling) + descendant weight. The consensus module is agnostic to how weight is derived.

**Sampling module**: Serves dual purposes:
1. **Correctness verification**: Re-executes contracts to check results.
2. **Weight determination**: Measures verification cost, producing the scaling factor that converts declared throughput to effective weight.

Sampling descends proportionally to declared throughput (structural metric), ensuring high-throughput subtrees receive proportional verification effort. See [sampling.md](sampling.md).

**Trust module / Deception equilibrium**: The aggregation fee f ~= v emerges from the game between publishers and aggregators. Collateral M * C is the security mechanism that funds the verification layer through the deception equilibrium. The fee is the weight mechanism; the collateral is the correctness mechanism. See [deception.md](deception.md).

**Block creation module**: Constructs the weight vector from the block's throughput and subtrees' weight vectors. Structural verification confirms the vector is correctly composed.

---

## Implementation

The verification-cost-based weight system is not yet implemented. The current code uses a trusted `declaredWeight` field. Throughput-based structural derivation and sampling-based weight verification are pending.

| File | Description |
|------|-------------|
| [`src/core/BlockCreationModule.ts`](../../src/core/BlockCreationModule.ts) | Weight vector derivation from throughput and subtrees |
| [`src/core/ConsensusModule.ts`](../../src/core/ConsensusModule.ts) | Verified vs declared weight, effective weight computation |
