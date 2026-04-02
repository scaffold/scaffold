# Trust Module

The trust module provides economic incentives for block validity. It does not determine whether a block is valid (that's the verification module) or which conflicting block wins (that's the consensus module). Instead, it ensures that:

1. **Publishers have skin in the game** — they lose money if their blocks are invalid.
2. **Verifiers are rewarded for detecting fraud** — they gain money by catching invalid blocks.
3. **Aggregators can assess risk** — they can estimate expected loss from undetected fraud in their subtrees.

Collateral is the mechanism. It is not a new primitive — collateral is a regular output with restricted spending conditions that reference another block's fate.

This module is responsible for:
- Defining how collateral is placed (Verifier Reward and Rectification outputs)
- Spending conditions on collateral outputs (when and by whom they can be redeemed)
- Encapsulated weight and claiming limits
- The aggregation risk model (how aggregators assess fraud exposure)

This module is **not** responsible for:
- Determining whether a block is valid (verification module)
- Resolving challenges -- the challenge/response mechanism ([collateral resolution contracts](collateral-resolution.md))
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

The publisher posts two separate collateral outputs per block, implemented as two separate contracts. See [collateral-resolution](collateral-resolution.md) for the full contract specification and [contracts](contracts.md) for the standard contract definitions.

### Two Contracts

**Verifier Reward Contract (Type 1 -- publisher's responsibility):**
- A single output per block, decays exponentially back to the publisher.
- Never transferred to an aggregator. The original publisher remains responsible.
- Can be challenged via AGAINST bonds (hash preimage requests or validity disputes).
- If challenged and undefended, the decayed remainder goes to the challenger.
- Because responding to challenges is profitable (you earn the AGAINST bond), anyone with the data can respond.

**Rectification Contract (Type 2 -- aggregator's responsibility):**
- A single fee output per block, claimed by the aggregator during aggregation.
- Aggregator accumulates fees into a rectification pot covering their aggregation tree.
- If an invalid block is discovered, the pot pays a finder's reward and restores victims.

### Initial Collateral

The publisher posts two outputs:

```
Verifier Reward output:  value = C1 (proportional to throughput T)
Rectification Fee output: value = f = v * T / T_avg
```

Both must exist independently of the target block -- neither can be a descendant of the block they vouch for.

### AGAINST Challenges

An AGAINST challenge is a separate output (using the Challenge Contract) that targets a specific aspect of a block via a discriminated union:

```
ChallengeTarget =
  | { type: 'validity' }                    // WASM re-execution dispute
  | { type: 'anchor' }                      // anchor hash preimage
  | { type: 'ref', index: number }          // ref hash preimage
  | { type: 'aggregate', index: number }    // aggregate hash preimage
  | { type: 'output', index: number }       // output content
```

- Hash challenges are self-resolving: the hash matches or it doesn't.
- Validity challenges require WASM re-execution.
- If the preimage is produced (or validity confirmed): AGAINST bond goes to the responder.
- If no response: Type 1 verifier reward decays to the challenger, Type 2 rectification triggers.

No explicit deadline -- the verifier reward decay IS the deadline. See [collateral-resolution](collateral-resolution.md).

### Spending Conditions

**Verifier Reward (Type 1):**
- **Decay return**: Publisher reclaims `C1 * exp(-c * age)` if unchallenged.
- **Challenge claim**: Challenger claims decayed remainder (locked at challenge timestamp).
- **Non-canonical reclaim**: Full return if target block loses consensus race.

**Rectification (Type 2):**
- **Aggregation claim**: Aggregator claims fee output, rolls into pot.
- **Rectification payout**: Invalid block proven -- finder's reward + victim restoration.
- **Non-canonical reclaim**: Full return if aggregation tree becomes non-canonical.
- **Solidification return**: Aggregator reclaims after sufficient time without challenges.

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

The two collateral types have different transfer mechanics:

**Type 1 (verifier reward) does not transfer.** The publisher remains responsible for their own block's short-term validity. Their collateral decays back to them over time. This keeps responsibility close to the information — the publisher knows their block best.

**Type 2 (rectification insurance) transfers through aggregation.** When an aggregator includes a block, they take on rectification responsibility. Each layer of aggregation is a new risk assessment. Centralized insurance clients are expected to manage most aggregated risk, competing on fee and verification rate.

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

**Collateral resolution contract** (see [collateral-resolution](collateral-resolution.md)): Hash challenges (structural validity) are self-resolving through the AGAINST/preimage mechanism -- no dispute module needed. Computational validity (WASM re-execution) may still require a separate dispute mechanism.

**Application layer**: This module does not define what "valid" means for any particular block type. Validity semantics are application-specific. This module only defines the economic incentives around validity.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Verifier Reward output | Block creation module | Publisher's Type 1 collateral (decay-based) |
| Rectification Fee output | Block creation module | Publisher's Type 2 fee (claimed by aggregator) |
| Challenge output (AGAINST) | Any peer | A bond targeting a specific hash or validity claim |
| Challenge resolution | Collateral resolution contracts | Preimage revealed (valid) or unresponded (invalid) |
| Block validity verdict | Verification module | Whether a specific block is valid or invalid |
| Canonical view updates | Consensus module | Whether H is canonical or non-canonical |
| Aggregation events | Block creation module | When H is aggregated by an aggregator |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Collateral spending conditions | Conflict module | Restricted spending rules on collateral outputs |
| Encapsulated weight | Collateral resolution contracts | The weight value used to compute claiming limits |
| Claiming limits | Collateral resolution contracts | Maximum claimable collateral per fraud event (W * N) |
| Trust signal | All modules | Whether a block has active collateral vouching for it |
| Aggregation risk estimates | Block creation module | Expected fraud exposure for potential aggregations |

### Invariants

1. **Independence from consensus**: Collateral does not influence which conflicting branch wins.
2. **No circular trust**: Collateral block C must not be a descendant of the block it vouches for.
3. **Monotonic fraud**: Once fraud is proven at a path, it cannot be retracted.
4. **Bounded claims**: Total claimable collateral per fraud event never exceeds encapsulated_weight * N.
5. **Split responsibility**: Type 1 (verifier reward) stays with publisher. Type 2 (rectification) transfers to aggregator. Both are always covered.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/TrustModule.ts`](../../src/core/TrustModule.ts) | Core algorithm: collateral placement, redemption, encapsulated weight |
| [`src/core/TrustService.ts`](../../src/core/TrustService.ts) | Wired adapter using concrete `Block` type |
