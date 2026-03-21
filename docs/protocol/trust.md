# Trust Module

The trust module provides economic incentives for block validity. It does not determine whether a block is valid (that's the verification module) or which conflicting block wins (that's the consensus module). Instead, it ensures that:

1. **Publishers have skin in the game** -- they lose money if their blocks are invalid.
2. **Verifiers are rewarded for detecting fraud** -- they gain money by catching invalid blocks.
3. **Risk is transferred efficiently** -- aggregation absorbs publisher risk, freeing capital.

Collateral is the mechanism. It is not a new primitive -- collateral is a regular output with restricted spending conditions that reference another block's fate.

---

## Validity vs. Conflict

These are distinct concepts:

- **Conflict** is structural -- two blocks claim the same output. Both can be perfectly valid. The consensus module resolves conflicts by verified descendant weight.
- **Validity** is correctness -- the block's computation is right. An invalid block *could* be canonical if it has enough descendant weight, though collateral makes this costly.

Collateral addresses validity, not conflict. A publisher who loses a consensus race to a valid competitor bears no penalty -- their collateral is returned.

---

## Collateral Output Structure

A collateral output is a `COLLATERAL_RESOLUTION` output that stakes value on a specific block's validity:

```
Output {
    value:    integer                        // the staked amount (entire value is at risk)
    verifier: {
        contract: COLLATERAL_RESOLUTION,
        params:   { coveredBlockHash: Hash }
    }
    detail: {
        publicKey:    Uint8Array,            // remittance address for refunds/winnings
        vote:         'FOR' | 'AGAINST',     // stance on the covered block's validity
        packagingFee: integer                // max fee the poster will pay for risk transfer
    }
}
```

**FOR** collateral asserts that `coveredBlockHash` (and its subtree) is valid. Publishers post FOR collateral on their own blocks. Other parties may also post FOR collateral if they believe a block is valid and want to profit from the dispute.

**AGAINST** collateral asserts that `coveredBlockHash` is invalid. Challengers post AGAINST collateral when they believe (or have verified) that a block is invalid.

The **entire output value** is at risk regardless of the `packagingFee`. The fee only affects the split between poster and packager on the happy path (see [Risk Transfer](#risk-transfer-via-aggregation)).

### Structural Rules

- The collateral block C must not be the covered block H itself, and C must not be a descendant of H. If H is found invalid and removed from the canonical view, any block descending from H is also removed -- including its outputs. Collateral inside such a block would vanish when it is most needed. Collateral must exist independently of the block it covers.
- C references H by hash only -- H is not an input or ancestor of C.
- C can anchor anywhere else in the DAG.

### Spending Conditions

Collateral outputs have restricted spending conditions:

- **Publisher redemption**: Spendable when the covered block has been aggregated (risk has been transferred to the aggregator).
- **Non-canonical reclaim**: Spendable if the covered block becomes non-canonical (publisher bears no penalty for losing a consensus race).
- **Resolution claim**: Claimable by the resolution contract when FOR/AGAINST disputes are resolved (see [Collateral Resolution](#collateral-resolution)).

---

## Collateral Resolution

The `COLLATERAL_RESOLUTION` contract handles both posting and resolution. When a resolution block claims all collateral outputs for a given `coveredBlockHash`, the contract:

1. **Sums the total staked value for each side** (total FOR, total AGAINST).
2. **Determines the winner** -- the side with more total value.
3. **For winning postings**: forwards `packagingFee` to itself (as a new COLLATERAL_RESOLUTION output on the resolution block) and returns `amount - packagingFee` to the poster's `publicKey`.
4. **For losing postings**: distributes the entire `amount` to winning `publicKey`s, proportionally to their stakes.

### Contract-Defined Bonus

The resolution contract defines a **claim bonus** equal to the total value returned to original posters:

```
bonus = SUM(amount_i - claimedFee_i)    for all claimed collateral outputs
```

Where `claimedFee_i <= packagingFee_i` is the fee actually charged by the packager (which may be less than the poster's maximum). This bonus incentivizes two behaviors:

1. **Claiming ALL posted collateral**, not just the ones matching the packager's vote. The bonus scales with the number and size of collateral outputs claimed.
2. **Charging smaller fees**. A packager charging a lower fee increases the bonus, making their claim more attractive relative to competing packagers.

This mechanism creates natural fee competition without requiring a consensus-level cheapest-claimer formula.

---

## The Voting Cascade

The FOR/AGAINST mechanism creates a self-amplifying verification signal:

1. **Detection**: A client (even a small one) detects an invalid block. They post AGAINST collateral with whatever they can afford.

2. **Signal propagation**: The AGAINST vote is gossiped to peers. Peers observe: someone spent real money contesting this block. This is a credible signal -- rational actors don't stake money on false claims (they'd lose it).

3. **Verification and amplification**: Peers who see the AGAINST vote have a potential profit opportunity. They re-execute the block's contract to verify independently. If the block is indeed invalid, they post their own AGAINST collateral, adding to the total.

4. **Cascade**: More AGAINST votes strengthen the signal further. Each new verifier increases confidence for the next. The process feeds on itself until the AGAINST total overwhelms the FOR total.

5. **Resolution**: Once sufficient AGAINST collateral has accumulated, a resolution block claims all collateral for the block hash. AGAINST wins. All AGAINST voters share the FOR collateral proportionally to their stakes.

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

1. **Publisher posts collateral**: Publisher creates block B and posts FOR collateral with `coveredBlockHash = B.hash`, staking value C.

2. **Aggregator aggregates**: An aggregator creates an aggregation block A that includes B in its subtree. The aggregator posts their own collateral covering A (and by extension, B and everything else in the subtree).

3. **Publisher capital is freed**: Once B is aggregated (A is canonical and includes B), the publisher's collateral spending condition "publisher redemption" is satisfied. The publisher can reclaim their collateral minus the `packagingFee`.

4. **Risk has transferred**: The aggregator's collateral now backs B's validity. If B is later found invalid, it is the aggregator's collateral that is at risk, not the publisher's (which has been redeemed).

### The Packaging Fee

The `packagingFee` in the publisher's collateral output is the maximum the publisher is willing to pay for risk transfer. It is the publisher's price for having their capital freed quickly.

The aggregator (acting as packager) charges `claimedFee <= packagingFee`. Competition between aggregators drives `claimedFee` toward marginal cost (which is the verification cost v, since the aggregator must verify the block before taking on the risk).

This is the aggregation fee f ~= v from the [deception equilibrium](deception.md). The packaging fee and the aggregation fee are the same mechanism viewed from different perspectives:
- From the weight perspective: the fee is the proof of weight (see [weight.md](weight.md)).
- From the trust perspective: the fee is the price of risk transfer.

### Per-Sub-Block Independence

When an aggregator's block covers multiple sub-blocks, disputes against individual sub-blocks are resolved independently. One invalid sub-block does NOT contaminate other sub-blocks' collateral.

This is critical for safety. Without per-sub-block independence:
- An attacker who knows one sub-block is invalid could post AGAINST collateral on the entire aggregation block.
- All honest publishers' collateral in that package would be at risk from a single bad block.
- The attacker profits by dragging valid blocks' collateral into a rigged resolution.

With per-sub-block independence:
- Each sub-block's FOR/AGAINST votes are resolved independently.
- An invalid sub-block only affects collateral posted against that specific sub-block.
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

### Collateral Decay

The aggregator's collateral per block is M * C, where M is the **payout multiplier** and C is the original publisher's collateral. M can be less than 1 -- reflecting the Bayesian reality that older blocks are less likely to be fraudulent. Collateral decays through successive re-aggregation at decreasing M.

For the game-theoretic analysis of equilibrium fraud rates and M's effect on verification behavior, see [deception](deception.md).

---

## Interaction with Other Modules

**Consensus module**: Collateral is orthogonal to consensus. Two blocks can conflict with both being valid -- consensus picks the winner by weight. Collateral addresses validity, not branch selection. If H becomes non-canonical, collateral on H is freed.

**Conflict module**: Collateral outputs use the standard output model. The conflict module detects double-spends on collateral outputs the same way it handles any other output.

**Verification module**: Verification determines whether a block's computation is correct. Trust determines the economic consequences. Verification provides facts; collateral provides stakes.

**Weight module**: The aggregation fee (f ~= v) serves dual purposes: it is the price of risk transfer (trust concern) and the proof of weight (consensus concern). See [weight.md](weight.md).

**Gossip module**: AGAINST votes are high-priority gossip. They signal potential profit for verifiers, triggering the voting cascade. The gossip module should prioritize propagation of collateral outputs, especially AGAINST votes.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Collateral placement (FOR) | Block creation module | A collateral output vouching for a target block's validity |
| Collateral placement (AGAINST) | Block creation module | A collateral output contesting a target block's validity |
| Resolution outcome | Resolution contract | Which side won for a given coveredBlockHash |
| Canonical view updates | Consensus module | Whether the covered block is canonical or non-canonical |
| Aggregation events | Block creation module | When the covered block is aggregated |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Collateral spending conditions | Conflict module | Restricted spending rules on collateral outputs |
| Encapsulated weight | Resolution contract | Weight value for computing claiming limits |
| Claiming limits | Resolution contract | Maximum claimable collateral per fraud event |
| Trust signal | All modules | Whether a block has active collateral vouching for it |
| Aggregation risk estimates | Block creation module | Expected fraud exposure for potential aggregations |

### Invariants

1. **Independence from consensus**: Collateral does not influence which conflicting branch wins.
2. **No circular trust**: Collateral block C must not be the covered block H or a descendant of H.
3. **Per-sub-block independence**: Disputes against sub-blocks within a package are resolved independently. One invalid sub-block cannot contaminate others' collateral.
4. **Bounded claims**: Total claimable collateral per fraud event never exceeds encapsulated_weight * N.
5. **Challenger skin in the game**: AGAINST votes require staking value at risk if the challenge fails.
6. **Risk transfer via aggregation**: Once the covered block is aggregated, the aggregator's collateral replaces the publisher's as the active trust signal.

---

## Open Questions

1. **Minimum challenger stake**: What is the right minimum for AGAINST collateral? Must exceed network verification cost to deter spam, but low enough that legitimate challenges are accessible.

2. **Claiming limit parameter N**: The range 5-500 needs empirical testing. Too low and fraud detection is unprofitable. Too high and publisher collateral requirements are impractical.

3. **Collateral decay schedule**: How quickly should M decrease through re-aggregation? Fixed schedule or market-driven?

4. **Contract-defined bonus specification**: The bonus mechanism (`bonus = SUM(amount - claimedFee)`) that incentivizes competitive fees and complete resolution claiming needs formal specification as a general contract primitive.

5. **Partial resolution**: Can resolution be batched (claim some collateral outputs now, the rest later)? This would defend against dust griefing (many small AGAINST outputs making a single resolution block impractically large).

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/TrustModule.ts`](../../src/core/TrustModule.ts) | Core algorithm: collateral placement, redemption, encapsulated weight |
| [`src/core/TrustService.ts`](../../src/core/TrustService.ts) | Wired adapter using concrete `Block` type |
