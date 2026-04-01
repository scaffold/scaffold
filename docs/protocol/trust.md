# Trust Module

The trust module provides economic incentives for block validity. It does not determine whether a block is valid (that's the verification module) or which conflicting block wins (that's the consensus module). Instead, it ensures that:

1. **Publishers have skin in the game** — they lose money if their blocks are invalid.
2. **Verifiers are rewarded for detecting fraud** — they gain money by catching invalid blocks.
3. **Aggregators can assess risk** — they can estimate expected loss from undetected fraud in their subtrees.

Collateral is the mechanism. It is not a new primitive — collateral is a regular output with restricted spending conditions that reference another block's fate.

This module is responsible for:
- Defining how collateral is placed (FOR and AGAINST votes on block validity)
- Spending conditions on collateral outputs (when and by whom they can be redeemed)
- Encapsulated weight and claiming limits
- The aggregation risk model (how aggregators assess fraud exposure)

This module is **not** responsible for:
- Determining whether a block is valid (verification module)
- Resolving FOR/AGAINST disputes — the voting mechanism (dispute module)
- Defining what "valid" means for a given block type (application layer)
- Deciding which conflicting block becomes canonical (consensus module)

---

## Validity vs. Conflict

These are distinct concepts:

- **Conflict** is structural — two blocks claim the same output. Both can be perfectly valid. The consensus module resolves conflicts by verified descendant weight.
- **Validity** is correctness — the block's computation is right. An invalid block *could* be canonical if it has enough descendant weight, though collateral makes this costly.

Collateral addresses validity, not conflict. A publisher who loses a consensus race to a valid competitor bears no penalty — their collateral is returned.

---

## Collateral Structure

A collateral block C is a block that vouches for the validity of a target block H and H's entire subtree (all blocks aggregated within H, recursively).

### Structural Rules

- C references H by hash only — H is not an input or ancestor of C.
- **C must not be H itself, and C must not be a descendant of H.** If H is found invalid and removed from the canonical view, any block that is H or descends from H is also removed — including its outputs. Collateral outputs inside such a block would vanish, making it impossible for verifiers to claim fraud rewards. Collateral must exist independently of the block it vouches for.
- C can anchor anywhere else in the DAG.

### Collateral as Output

Collateral is a regular output produced by C, with restricted spending conditions. There are two types of collateral placement:

- **FOR**: Asserts that a block (or a specific path within a block's subtree) is valid. The initial FOR collateral has path `[]`, meaning it vouches for the entire block. Later FOR placements may target a specific path like `[3, 0, 1]` to contest a specific fraud allegation.
- **AGAINST**: Asserts that a specific block within H's subtree is invalid. Must include a path like `[3, 0, 1]` identifying the allegedly invalid block by its child indices within the tree. Each AGAINST vote targets one specific block, not a subtree — multiple AGAINST votes can independently target different blocks.

### Spending Conditions

Collateral outputs have restricted spending conditions:

- **Publisher redemption**: Can only be spent in a block that has an aggregator of H as an ancestor (the risk has been handed off to the aggregator).
- **Non-canonical reclaim**: Can be spent if H becomes non-canonical (publisher bears no penalty for losing a consensus race).
- **Fraud claim**: Can be claimed by the winning side of a FOR/AGAINST dispute (resolution mechanism defined in the dispute module).

The specifics of the spending contract (e.g., whether descendants of the aggregator qualify) are properties of the collateral contract itself and may vary.

---

## Encapsulated Weight and Claiming Limits

When fraud is detected at a specific block within H's subtree, the amount of collateral claimable is bounded. This prevents a small fraud from draining disproportionate collateral, and calibrates the incentive to the actual risk.

### Encapsulated Weight

**Encapsulated weight** is the value used to compute the claiming limit. For a sub-block B within an aggregation tree:

- Normally, encapsulated weight equals B's declared weight — the work B claims to have done.
- **Exception**: If an ancestor aggregator of B declared B's contribution as smaller than B's actual declared weight, the encapsulated weight is the aggregator's claimed value, not B's.

The reason for this exception: an adversary could hide a very heavy invalid block inside a lightweight aggregation. The aggregator might claim the subtree contributes weight 10, but the actual sub-block declares weight 10,000. If an honest aggregator further up probes based on declared weight, the lightweight aggregation is unlikely to be sampled, and the fraud goes undetected. In this case, the lying aggregator is the one at fault, and the claiming limit should reflect the weight they exposed to the system — not the hidden weight.

### Claiming Limit

When block W is found invalid, total claimable collateral is capped at:

```
claim_limit = encapsulated_weight(W) * N
```

Where N is a protocol parameter (tentatively in the range 5–500, to be determined). N must be large enough that fraud detection is profitable for verifiers, but small enough that the collateral requirement for publishers remains practical.

FOR and AGAINST collateral at the relevant path forms the pool. The winning side claims from the losing side's collateral, up to this limit.

---

## Aggregation Risk Model

Aggregation is inherently risky. When an aggregator creates a block that aggregates a subtree, it vouches for that subtree's validity with its own collateral. If any block in the subtree is later found invalid, the aggregator's collateral is at risk.

Aggregation is also profitable. All blocks incentivize aggregation by paying some amount to their aggregator. The aggregator's challenge is to balance this profit against the expected loss from undetected fraud.

### Probing

Before aggregating a subtree, an aggregator should sample and verify blocks within it. Probing provides a statistical bound on fraud exposure:

- If the aggregator probes K blocks and finds none invalid, it can estimate an upper bound on the fraud rate in the subtree.
- The expected loss is then: `fraud_rate_bound * total_subtree_weight * N` (since each fraudulent block can trigger up to W * N in claims).
- Aggregation is profitable if: `aggregation_fees > expected_loss`.

### Speed vs. Safety Tradeoff

The aggregator races against other potential aggregators — the first to produce a canonical aggregation captures the fees (see consensus module). This creates pressure to aggregate quickly, but probing too little increases fraud exposure. The equilibrium depends on the fraud rate in the network: in a mostly-honest network, minimal probing is sufficient; as fraud increases, aggregators must probe more, slowing aggregation and increasing costs.

### Collateral Cascading and Risk Transfer

The aggregator places its own collateral on the aggregation block. This transfers risk up the chain — the original publisher's collateral can be redeemed once their block is aggregated, because the aggregator is now the one with skin in the game. Each layer of aggregation is a new risk assessment and a new collateral commitment.

The aggregator's collateral per block is M * C, where M is the **payout multiplier** and C is the original publisher's collateral. M can be less than 1 — an aggregator can stake less than the original publisher. This reflects the Bayesian reality that older blocks are less likely to be fraudulent. Collateral decays through successive re-aggregation at decreasing M.

Risk transfer should happen within seconds of publication to free the publisher's capital. Centralized insurance clients are expected to manage most aggregated risk, competing on fee and verification rate.

### Partial Collateral Coverage

An aggregator covering N blocks does not need to post N * M * C total collateral. Since the expected fraud rate is low (p = v / (M * C)), the aggregator posts a fraction of the worst case — e.g., 10%. The reserve covers the first discovered invalidities. At the equilibrium fraud rate (p = 0.2% for M = 0.5), expected invalid blocks per 1000 is 2, so a 10% reserve provides 50x headroom. Correlated fraud is detectable through random sampling: one hit triggers deeper investigation or batch rejection. See [deception](deception.md) for the full analysis.

### Throughput-Proportional Fees

Collateral is proportional to block throughput T (coins in = coins out): `C_i = k * T_i`. The aggregation fee is also proportional to throughput:

```
f_i = v * T_i / T_avg
```

This defines a constant aggregation tax rate (`v / T_avg`) on throughput. Every block pays the same percentage. The aggregator's verification probability q is the same for all blocks (throughput-independent at equilibrium), but the risk per block scales with throughput, so the fee must scale to match.

### Bayesian Risk Decay

As a block ages without being contested, the posterior probability of invalidity decays exponentially:

```
P(invalid | unchallenged for t) ≈ p * e^(-lambda * t)
```

Where lambda is the detection rate (driven primarily by the self-flagging incentive of deceptive publishers). Required collateral at time t tracks this decay, enabling re-aggregation at successively lower collateral. The total fee across all re-aggregation levels converges to approximately v — one fee covers the block's entire lifecycle. See [deception](deception.md) for the cascade model and formulas.

For the game-theoretic analysis of risk transfer incentives, equilibrium fraud rates, and the effect of M on verification behavior, see [deception](deception.md).

---

## Interaction with Other Modules

**Consensus module**: Collateral is orthogonal to consensus. Two blocks can conflict (claim the same outputs) with both being perfectly valid — consensus picks the winner by weight. Collateral addresses validity, not branch selection. The one interaction: if H becomes non-canonical, collateral on H is freed because there's nothing to vouch for anymore. Note that an invalid block *could* be canonical if it has enough descendant weight, though collateral makes this costly.

**Conflict module**: Collateral outputs use the same output model as everything else. Collateral is an output with special spending conditions — no new primitives. The conflict module detects double-spends on collateral outputs the same way it handles any other output.

**Verification module**: Verification determines whether a block's declared work is real (spot-checking). Trust determines the economic consequences of that verdict. Verification provides the facts; collateral provides the stakes. Verified weight feeds into consensus; fraud detection feeds into collateral claims.

**Dispute module** (not yet specified): The trust module defines that FOR and AGAINST collateral placements exist, and that the winning side claims the losing side's stake. The dispute module defines *how* disputes are resolved — the voting mechanism, evidence requirements, and how a winner is determined. This module treats dispute resolution as an interface: given a dispute outcome, collateral flows to the winner.

**Application layer**: This module does not define what "valid" means for any particular block type. Validity semantics are application-specific. This module only defines the economic incentives around validity.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Collateral placement (FOR) | Block creation module | A block vouching for target H's validity, with path and staked output |
| Collateral placement (AGAINST) | Block creation module | A block alleging invalidity at a specific path within H's subtree |
| Dispute outcome | Dispute module | Which side (FOR/AGAINST) won for a given path |
| Block validity verdict | Verification module | Whether a specific block is valid or invalid |
| Canonical view updates | Consensus module | Whether H is canonical or non-canonical |
| Aggregation events | Block creation module | When H is aggregated by an aggregator |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Collateral spending conditions | Conflict module | Restricted spending rules on collateral outputs |
| Encapsulated weight | Dispute module | The weight value used to compute claiming limits |
| Claiming limits | Dispute module | Maximum claimable collateral per fraud event (W * N) |
| Trust signal | All modules | Whether a block has active collateral vouching for it |
| Aggregation risk estimates | Block creation module | Expected fraud exposure for potential aggregations |

### Invariants

1. **Independence from consensus**: Collateral does not influence which conflicting branch wins.
2. **No circular trust**: Collateral block C must not be a descendant of the block it vouches for.
3. **Monotonic fraud**: Once fraud is proven at a path, it cannot be retracted.
4. **Bounded claims**: Total claimable collateral per fraud event never exceeds encapsulated_weight * N.
5. **Risk transfer**: Once H is aggregated, the aggregator's collateral replaces the publisher's as the active trust signal.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/TrustModule.ts`](../../src/core/TrustModule.ts) | Core algorithm: collateral placement, redemption, encapsulated weight |
| [`src/core/TrustService.ts`](../../src/core/TrustService.ts) | Wired adapter using concrete `Block` type |
