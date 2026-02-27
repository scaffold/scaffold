# Sampling Module

The sampling module determines which trees to verify and maintains a statistical model of each tree's work authenticity. Its output is a probability distribution per tree, consumed by the consensus module for weight computation and by this module internally for verification prioritization.

The consensus module specifies the verification interface: it expects verified weights that converge toward declared weights for honest trees and toward zero for fraudulent ones. This module fulfills that interface through statistical sampling.

---

## State Model

For each tree T, the module maintains:

```
SamplingState {
    declared_work:  Number     // W — total work declared by the tree
    successes:      Number     // n — samples verified as real
    failures:       Number     // f — failed samples (includes pending)
}
```

Where `s = n + f` is the total sample count.

**Pending samples**: When a sample is requested but not yet resolved, it is immediately counted as a failure. When it resolves:

- **Success**: `n += 1, f -= 1` (flipped from failure to success)
- **Failure**: no change (already counted)

This "pessimistic pending" model ensures the tree looks worse while we wait, providing natural backpressure against redundant requests without a separate throttling mechanism. Failure encompasses both unavailability (block could not be fetched) and invalidity (computation did not match).

---

## Output Distribution

The module outputs a Beta distribution representing belief about the fraction of real work in the tree:

```
p_real ~ Beta(n, f + 1)
```

This uses an improper prior `Beta(0, 1)`, making the model maximally pessimistic — a tree contributes zero verified weight until its first successful sample:

| State | Distribution | E[p] | Verified Weight |
|-------|-------------|------|-----------------|
| Unsampled (n=0, f=0) | Beta(0, 1) | 0 | 0 |
| 1 success, 0 failures | Beta(1, 1) | 1/2 | W/2 |
| 5 successes, 0 failures | Beta(5, 1) | 5/6 | 5W/6 |
| 0 successes, 5 failures | Beta(0, 6) | 0 | 0 |
| 3 successes, 2 failures | Beta(3, 3) | 1/2 | W/2 |

The verified weight is:

```
v(T) = W × n / (n + f + 1)
```

The consensus module receives the full distribution and interprets it according to its own needs (mean, lower quantile, etc.).

---

## Sampling Priority

To decide where to sample next, the module computes a priority score for each tree reflecting the expected value of information from one additional sample.

### Expected Weight Swing

For priority computation, we use the proper prior `Beta(n + 1, f + 1)` rather than the pessimistic output prior. The question here is not "what do we believe?" but "how much could we learn?" — and these require different priors:

```
expected_swing(T) = 2W × Var(Beta(n + 1, f + 1))
                  = 2W(n + 1)(f + 1) / [(s + 2)²(s + 3)]
```

**Derivation**: The expected absolute change in verified weight from one additional sample equals `2W × Var(p)`. This follows from computing the Bayesian update in each direction (success vs failure), weighting by their posterior predictive probabilities, and noting the result simplifies to twice the posterior variance scaled by the declared work.

### Descendant Dampening

Trees with high verified descendant weight `D` (provided by the consensus module) are already well-established in consensus. Further verification of the tree itself has diminishing impact:

```
dampening(T) = W / (W + D)
```

### Priority Formula

```
priority(T) = 2W(n + 1)(f + 1) / [(s + 2)²(s + 3)]  ×  W / (W + D)
```

The tree with the highest priority is selected for sampling.

---

## Emergent Behaviors

The priority formula produces several desirable behaviors without explicitly modeling them:

**Recency preference.** New trees have `s = 0` and `D = 0`, giving maximum priority per unit of declared work. Old verified trees have high `s` and high `D`. No explicit time parameter is needed — recency emerges from the information structure.

**Fraud deprioritization.** Trees that consistently fail accumulate high `f` with `n = 0`. Their verified weight stays at zero, they lose consensus conflicts, nobody builds on them (`D` remains 0), and their priority decays as `~1/f`. They fall off naturally without a blacklist.

**Pending saturation.** Each pending sample inflates `f`, reducing priority. Five pending samples on an otherwise unsampled tree drop priority from `W/6` to roughly `W/32`. When samples resolve as successes, `f` decreases and priority partially recovers.

**Descendant confidence.** A tree with `10×` its declared work in verified descendants has `dampening ≈ 0.09`, reducing priority by `~11×`. Confidence flows upward: extensive verified work built on a tree is itself evidence of authenticity.

---

## Sampling Procedure

1. Compute `priority(T)` for all trees with unresolved work (`v(T) < W`).
2. Select the tree `T*` with the highest priority.
3. Choose a random unit of work from `T*`'s declared work.
4. Descend the tree structure, requesting child blocks from peers, until the unit is located.
5. Mark the sample as pending (`f += 1`).
6. When resolved, update state (success: `n += 1, f -= 1`; failure: no change).
7. Emit the updated distribution to the consensus module.

---

## Concrete Example

### Setup

Three trees, no samples yet:

| Tree | W | n | f | D |
|------|---|---|---|---|
| A | 1000 | 0 | 0 | 0 |
| B | 500 | 0 | 0 | 0 |
| C | 200 | 10 | 0 | 5000 |

### Initial Priorities

```
priority(A) = 2×1000×1×1 / (4×3) × 1000/1000 = 167
priority(B) = 2×500×1×1 / (4×3) × 500/500 = 83
priority(C) = 2×200×11×1 / (144×13) × 200/5200 ≈ 0.09
```

Tree A is sampled first — highest declared work, no verification, no descendants. Tree C has been verified many times and has massive descendant weight, so it is effectively ignored.

### After Sampling Tree A (Mixed Results)

Five samples requested. Three succeed, two still pending (counted as failures).

State: `n = 3, f = 2, s = 5`.

```
Distribution: Beta(3, 3), E[p] = 0.5, v(A) = 500
priority(A) = 2×1000×4×3 / (49×8) × 1000/1000 ≈ 61
```

Priority has dropped from 167 to 61. Half the work is tentatively verified; there is less to learn.

### Tree A Turns Out Fraudulent

All samples eventually fail. State: `n = 0, f = 10, s = 10`.

```
Distribution: Beta(0, 11), E[p] = 0, v(A) = 0
priority(A) = 2×1000×1×11 / (144×13) × 1000/1000 ≈ 12
```

Priority has dropped from 167 to 12. Verified weight is zero — Tree A loses all consensus conflicts. Further sampling continues to decrease in priority as `f` grows.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Tree declared work | Block creation module | `W` for each tree |
| Verified descendant weight | Consensus module | `D` for priority dampening |
| Sample results | Verification module | Success/failure for each sampled unit |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Work distribution per tree | Consensus module | `Beta(n, f + 1)` representing belief about fraction of real work |
| Sample requests | Network/peer layer | Which tree and unit of work to fetch and verify |
