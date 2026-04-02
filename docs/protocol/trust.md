# Trust Module

The trust module provides economic incentives for block validity. It does not determine whether a block is valid (that's the verification module) or which conflicting block wins (that's the consensus module). Instead, it ensures that:

1. **Publishers have skin in the game** -- they lose money if their blocks are invalid.
2. **Verifiers are rewarded for detecting fraud** -- they gain money by catching invalid blocks.
3. **Risk is transferred efficiently** -- aggregation absorbs publisher risk, freeing capital.

Collateral is the mechanism. It is not a new primitive -- collateral is a regular output with restricted spending conditions that reference another block's fate.

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

- **Conflict** is structural -- two blocks claim the same output. Both can be perfectly valid. The consensus module resolves conflicts by verified descendant weight.
- **Validity** is correctness -- the block's computation is right. An invalid block *could* be canonical if it has enough descendant weight, though collateral makes this costly.

Collateral addresses validity, not conflict. A publisher who loses a consensus race to a valid competitor bears no penalty -- their collateral is returned.

---

## Collateral and Insurance

The author posts two separate outputs per block, implemented as two separate contracts. See [collateral-resolution](collateral-resolution.md) for the full contract specification and [contracts](contracts.md) for the standard contract definitions.

### Two Contracts

**Collateral Contract (author's responsibility):**
- FOR output per block. Decays exponentially back to the author if unchallenged.
- Never transferred to an aggregator. The original author remains responsible.
- AGAINST postings challenge a specific aspect of the block (hash preimage or validity).
- FOR and AGAINST share the same verifier (target block hash), so `collectInputs()` returns all of them.
- Because responding to AGAINST is profitable (you earn the bond), anyone with the data can respond.

**Insurance Contract (risk transfer):**
- Author posts insurance as a deposit (proportional to throughput).
- Upon aggregation, most is returned to the author minus a fee approximating the verification cost.
- The aggregator posts their own insurance covering the entire aggregated subtree.
- If an invalid block is discovered, the aggregator's insurance pays finder's reward and restores victims.

### Initial Outputs

The author posts two outputs:

```
Collateral output (FOR): value = C1 (proportional to throughput T)
Insurance output:         value = I  (proportional to throughput T)
```

Both must exist independently of the target block -- neither can be a descendant of the block they vouch for. The collateral block C must not be the covered block H itself, and C must not be a descendant of H. If H is found invalid and removed from the canonical view, any block descending from H is also removed -- including its outputs. Collateral inside such a block would vanish when it is most needed. C references H by hash only -- H is not an input or ancestor of C.

### AGAINST Challenges

An AGAINST challenge is a collateral output (same contract, same params as FOR) that targets a specific aspect of a block via a discriminated union in the detail:

```
ChallengeTarget =
  | { type: 'validity' }                          // WASM re-execution dispute
  | { type: 'anchor' }                            // anchor hash preimage
  | { type: 'ref', index: number }                // ref hash preimage
  | { type: 'aggregate', index: number }           // aggregate hash preimage
  | { type: 'output_verifier_contract', index: number }  // output verifier contract hash
```

- Hash challenges are self-resolving: the hash matches or it doesn't.
- Validity challenges require WASM re-execution.
- If the preimage is produced (or validity confirmed): AGAINST bond goes to the responder.
- If no response: collateral decays to the challenger, insurance rectification triggers.

No explicit deadline -- the collateral decay IS the deadline. See [collateral-resolution](collateral-resolution.md).

### Spending Conditions

**Collateral:**
- **Decay return**: Author reclaims `C1 * exp(-c * age)` if no AGAINST exists.
- **Hash response**: Responder reveals preimage, earns AGAINST bond. FOR unaffected.
- **Unresolved challenge**: Challenger claims decayed FOR (locked at challenge timestamp).
- **Non-canonical reclaim**: Full return to both sides.

**Insurance:**
- **Aggregation claim**: Aggregator claims author's insurance, returns most minus fee, posts own insurance for the tree.
- **Rectification payout**: Invalid block proven -- finder's reward + victim restoration.
- **Non-canonical reclaim**: Full return.
- **Solidification return**: Aggregator reclaims after sufficient time without challenges.

---

## The Voting Cascade

The FOR/AGAINST mechanism creates a self-amplifying verification signal:

1. **Detection**: A client (even a small one) detects an invalid block. They post AGAINST collateral with whatever they can afford.

2. **Signal propagation**: The AGAINST vote is gossiped to peers. Peers observe: someone spent real money contesting this block. This is a credible signal -- rational actors don't stake money on false claims (they'd lose it).

3. **Verification and amplification**: Peers who see the AGAINST vote have a potential profit opportunity. They re-execute the block's contract to verify independently. If the block is indeed invalid, they post their own AGAINST collateral, adding to the total.

4. **Cascade**: More AGAINST votes strengthen the signal further. Each new verifier increases confidence for the next. The process feeds on itself until the AGAINST total overwhelms the FOR total.

5. **Resolution**: Once sufficient AGAINST collateral has accumulated, the AGAINST side wins. All AGAINST voters share the FOR collateral proportionally to their stakes.

### Properties

- **Low barrier to initiation**: The first challenger needs only a small stake. The reward (proportional share of FOR collateral) far exceeds the cost.
- **Self-funding verification**: Each verifier who confirms the invalidity adds stake AND funds their own potential reward. Verification is profitable, not altruistic.
- **Proportional reward**: Voters are rewarded proportionally to their stake, incentivizing larger commitments from those with higher confidence.
- **Resilience to false alarms**: If a challenger posts AGAINST on a valid block, peers who verify find the block is correct. They don't add AGAINST votes. The challenger loses their stake to the FOR side. False signals are self-correcting and costly to the initiator.
- **No minimum detection capability**: Any node, regardless of size, can initiate the cascade. The mechanism turns a small, uncertain signal into a large, confident one through economic amplification.

---

## Risk Transfer via Aggregation

Risk transfer is not a separate protocol step -- it happens through aggregation. When an aggregator creates an aggregation block that includes a publisher's block, the aggregator implicitly takes on the validity risk for that subtree.

### How It Works

1. **Publisher posts collateral**: Publisher creates block B and posts FOR collateral vouching for B's validity.

2. **Aggregator aggregates**: An aggregator creates an aggregation block A that includes B in its subtree. The aggregator takes on rectification responsibility for the subtree.

3. **Publisher capital is freed**: Once B is aggregated, the publisher's Type 1 verifier reward collateral decays back to them (if unchallenged). The aggregator's rectification pot covers long-term risk.

4. **Risk has transferred**: The aggregator's rectification pot now backs B's validity for the long term.

### Per-Sub-Block Independence

When an aggregator's block covers multiple sub-blocks, disputes against individual sub-blocks are resolved independently. One invalid sub-block does NOT contaminate other sub-blocks' collateral.

This is critical for safety. Without per-sub-block independence:
- An attacker who knows one sub-block is invalid could challenge the entire aggregation block.
- All honest publishers' collateral would be at risk from a single bad block.

With per-sub-block independence:
- Each sub-block's challenges are resolved independently.
- An invalid sub-block only affects collateral related to that specific sub-block.
- Honest publishers' collateral is safe regardless of other sub-blocks' validity.

The aggregator's own collateral is proportionally at risk for each invalid sub-block, bounded by the claiming limit (see [Encapsulated Weight](#encapsulated-weight-and-claiming-limits)).

---

## Encapsulated Weight and Claiming Limits

When fraud is detected at a specific block within a subtree, the amount of collateral claimable is bounded. This prevents a small fraud from draining disproportionate collateral, and calibrates the incentive to the actual risk.

### Encapsulated Weight

**Encapsulated weight** is the value used to compute the claiming limit. For a sub-block B within an aggregation tree:

- Normally, encapsulated weight equals B's throughput -- the total value of inputs B claimed.
- **Exception**: If an ancestor aggregator of B declared B's contribution as smaller than B's actual throughput, the encapsulated weight is the aggregator's claimed value, not B's. This prevents an adversary from hiding a very heavy invalid block inside a lightweight aggregation claim.

### Claiming Limit

When block W is found invalid, total claimable collateral is capped at:

```
claim_limit = encapsulated_weight(W) * N
```

Where N is a protocol parameter (tentatively 5-500, to be determined). N must be large enough that fraud detection is profitable for verifiers, but small enough that collateral requirements remain practical.

---

## Challenger Collateral

Posting AGAINST collateral is not free. The challenger stakes value that they lose if the challenge fails (the block turns out to be valid). This is essential:

- **Without challenger collateral**: Fault proofs and AGAINST votes are a free DoS vector. An attacker can spam thousands of false challenges, each forcing the network to re-execute potentially expensive contracts to verify. Cost to attacker: zero. Cost to network: thousands of contract executions.

- **With challenger collateral**: Each false challenge costs the challenger their stake. The minimum stake should cover at least the network's verification cost for checking the claim, making spam uneconomical. A reasonable minimum might be several multiples of v (the verification cost), so the attacker overpays for any DoS attempt.

The asymmetry is intentional: the challenger's potential reward (proportional share of FOR collateral, potentially hundreds or thousands) far exceeds their stake (a few multiples of v). This makes legitimate challenges very profitable while making spam very costly.

---

## Aggregation Risk Model

Aggregation is inherently risky. When an aggregator creates a block that aggregates a subtree, it vouches for that subtree's validity with its own collateral. If any block in the subtree is later found invalid, the aggregator's collateral is at risk (bounded by the claiming limit).

### Probing

Before aggregating a subtree, an aggregator should sample and verify blocks within it:

- If the aggregator probes K blocks and finds none invalid, it can estimate an upper bound on the fraud rate.
- The expected loss is: `fraud_rate_bound * total_subtree_throughput * N`.
- Aggregation is profitable if: `aggregation_fees > expected_loss`.

### Speed vs. Safety Tradeoff

The aggregator races against other potential aggregators -- the first to produce a canonical aggregation captures the fees. This creates pressure to aggregate quickly, but probing too little increases fraud exposure. The equilibrium depends on the fraud rate: in a mostly-honest network, minimal probing is sufficient; as fraud increases, aggregators must probe more.

### Collateral and Insurance Transfer Mechanics

**Collateral does not transfer.** The author remains responsible for their own block's short-term validity. Their collateral decays back to them over time. This keeps responsibility close to the information -- the author knows their block best.

**Insurance transfers through aggregation.** When an aggregator includes a block, they claim the author's insurance deposit, return most of it minus the risk transfer fee, and post their own insurance covering the tree. Each layer of aggregation is a new risk assessment. Centralized insurance clients are expected to manage most aggregated risk, competing on fee and verification rate.

### Partial Collateral Coverage

An aggregator covering N blocks does not need to post N * M * C total collateral. Since the expected fraud rate is low (p = v / (M * C)), the aggregator posts a fraction of the worst case -- e.g., 10%. The reserve covers the first discovered invalidities. At the equilibrium fraud rate (p = 0.2% for M = 0.5), expected invalid blocks per 1000 is 2, so a 10% reserve provides 50x headroom. Correlated fraud is detectable through random sampling: one hit triggers deeper investigation or batch rejection. See [deception](deception.md) for the full analysis.

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

Where lambda is the detection rate (driven primarily by the self-flagging incentive of deceptive publishers). Required collateral at time t tracks this decay, enabling re-aggregation at successively lower collateral. The total fee across all re-aggregation levels converges to approximately v -- one fee covers the block's entire lifecycle. See [deception](deception.md) for the cascade model and formulas.

For the game-theoretic analysis of risk transfer incentives, equilibrium fraud rates, and the effect of M on verification behavior, see [deception](deception.md).

---

## Interaction with Other Modules

**Consensus module**: Collateral is orthogonal to consensus. Two blocks can conflict with both being valid -- consensus picks the winner by weight. Collateral addresses validity, not branch selection. If H becomes non-canonical, collateral on H is freed.

**Conflict module**: Collateral outputs use the standard output model. The conflict module detects double-spends on collateral outputs the same way it handles any other output.

**Verification module**: Verification determines whether a block's computation is correct. Trust determines the economic consequences. Verification provides facts; collateral provides stakes.

**Collateral resolution contract** (see [collateral-resolution](collateral-resolution.md)): Hash challenges (structural validity) are self-resolving through the AGAINST/preimage mechanism -- no dispute module needed. Computational validity (WASM re-execution) may still require a separate dispute mechanism.

**Weight module**: The aggregation fee (f ~= v) serves dual purposes: it is the price of risk transfer (trust concern) and the proof of weight (consensus concern). See [weight.md](weight.md).

**Gossip module**: AGAINST votes are high-priority gossip. They signal potential profit for verifiers, triggering the voting cascade. The gossip module should prioritize propagation of collateral outputs, especially AGAINST votes.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Collateral output (FOR) | Block creation module | Author's collateral (decay-based) |
| Insurance output | Block creation module | Author's insurance deposit |
| Collateral output (AGAINST) | Any peer | A bond challenging a specific hash or validity claim |
| Challenge resolution | Collateral contract | Preimage revealed (valid) or unresponded (invalid) |
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
2. **No circular trust**: Collateral block C must not be the covered block H or a descendant of H.
3. **Per-sub-block independence**: Disputes against sub-blocks within a package are resolved independently. One invalid sub-block cannot contaminate others' collateral.
4. **Bounded claims**: Total claimable collateral per fraud event never exceeds encapsulated_weight * N.
5. **Split responsibility**: Collateral stays with author. Insurance transfers to aggregator via fee. Both are always covered.
6. **Challenger skin in the game**: AGAINST collateral requires staking value at risk if the challenge fails.
7. **Risk transfer via aggregation**: Once aggregated, the aggregator's insurance replaces the author's insurance deposit.

---

## Open Questions

1. **Minimum challenger stake**: What is the right minimum for AGAINST collateral? Must exceed network verification cost to deter spam, but low enough that legitimate challenges are accessible.

2. **Claiming limit parameter N**: The range 5-500 needs empirical testing. Too low and fraud detection is unprofitable. Too high and publisher collateral requirements are impractical.

3. **Collateral decay schedule**: How quickly should M decrease through re-aggregation? Fixed schedule or market-driven?

4. **Partial resolution**: Can resolution be batched (claim some collateral outputs now, the rest later)? This would defend against dust griefing (many small AGAINST outputs making a single resolution block impractically large).

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/TrustModule.ts`](../../src/core/TrustModule.ts) | Core algorithm: collateral placement, redemption, encapsulated weight |
| [`src/core/TrustService.ts`](../../src/core/TrustService.ts) | Wired adapter using concrete `Block` type |
