# Exploration 6: Computation Chain Dynamics

## Direction

Analyze how the deception game, verification, and chain recovery
interact in self-perpetuating computation chains — the E4 pattern
where each computation's result output IS the next computation's
request. A trap at link N invalidates everything built on top. What
are the cascading effects, who bears the costs, and does the
equilibrium hold?

---

## The Cascade Problem

In a computation chain:

```
state_0 → state_1 → state_2 → ... → state_N
       ↓         ↓         ↓              ↓
    (valid)   (valid)   (TRAP!)      (wrong input)
```

If state_2 is a deception trap (intentionally wrong result):
- state_3 was computed from state_2's wrong output
- state_3's computation is "correct" (it faithfully ran the program
  on the wrong input), but its result is meaningless
- state_4, state_5, ... all inherit the wrong state
- When state_2 is caught, everything downstream collapses

### What Happens Mechanically

1. State_2 is proven invalid (verifier re-executes, result doesn't
   match).
2. State_2's outputs become non-canonical.
3. State_3 claimed state_2's output → state_3 is now claiming a
   non-canonical output → state_3 becomes non-canonical.
4. Cascading: state_4, 5, ... N all become non-canonical.
5. The chain "rewinds" to state_1 (last valid state).

### Who Bears Costs?

| Participant | Outcome | Loss |
|-------------|---------|------|
| Publisher of state_2 (deceiver) | Caught, loses FOR collateral | -c (e.g., -1000) |
| Publishers of states 3-N (innocent) | Non-canonical, collateral returned | Opportunity cost only (time, computation) |
| Requesters of states 3-N | Bounties lost (paid for non-canonical results) | Lost bounty value |
| Aggregator (if aggregated) | State_2 in subtree → subtree invalid | Collateral at risk |
| The deceiver (if self-catch) | Claims aggregator collateral | +j (e.g., +1M) |

**Key observation**: Innocent chain publishers lose opportunity cost
but NOT collateral. The trust module's "non-canonical reclaim" rule
returns their collateral. They did nothing wrong — they computed
correctly from the inputs they were given.

**Requesters** bear the real cost. They paid bounties for results
that turned out to be meaningless. This is analogous to building on
a branch that loses a consensus race — your work is discarded, and
any value you committed is gone.

---

## The Verification Pipeline Effect

Computation chains create a natural verification pipeline. Each new
link is an opportunity to detect the trap:

```
state_0 → state_1 → state_2(trap) → state_3 → state_4 → state_5
                          ↑             ↑          ↑          ↑
                       Verifier A   Verifier B  Verifier C  Verifier D
```

As the chain grows, more blocks are published, and the sampling module
selects more blocks for verification. If ANY block in the chain
(including the trap block or any descendant) is selected for
verification:

- **If state_2 is selected**: Direct detection. Re-execute, discover
  the result doesn't match.
- **If state_3 is selected**: Indirect detection. The verifier
  re-executes compute(state_2's_result). This produces a "correct"
  state_3 from the WRONG state_2 output. The verification PASSES
  for state_3 itself. The trap at state_2 is NOT detected.

Wait — this is important. Verifying state_3 doesn't catch the trap
at state_2. Each link is verified independently: "given THIS input,
did the program produce THIS output?" The input (state_2's wrong
output) is taken as given.

**The verification pipeline only catches the trap if the trap block
itself is sampled.** Downstream blocks pass verification because
they correctly computed from (wrong) inputs.

### Detection Probability

For a chain of length L after the trap, the probability of catching
the trap within K samples of the chain region:

```
P(catch) = 1 - (1 - W_trap / W_total)^K
```

Where W_trap is the trap block's weight and W_total is the total
weight of the chain region. If all blocks have equal weight:

```
P(catch) = 1 - (1 - 1/L)^K ≈ K/L for small K/L
```

With K=5 samples and L=20 blocks: P(catch) ≈ 25%.

**Conclusion**: Longer chains DON'T make traps easier to catch
through the pipeline effect. The probability of catching a specific
trap is proportional to its weight share, regardless of chain length.
This is the same as for non-chain blocks.

---

## Chain Recovery

After a trap is caught and the chain rewinds:

### Fast Recovery

```
Before catch:  state_0 → state_1 → state_2(trap) → state_3 → ... → state_N
After catch:   state_0 → state_1 → ???

Recovery:      state_0 → state_1 → state_2'(correct) → state_3' → ... → state_N'
```

A new responder computes the correct state_2' from state_1. Then
state_3' from state_2', etc. The chain recovers from the rewind point.

### Recovery Speed

Recovery requires re-publishing L blocks (the length of the
invalidated chain). Each block requires:
1. Computing the next state
2. Publishing the block
3. Posting collateral

If the original chain took T time to grow to length L, recovery
takes roughly T time as well (same computation, same publishing
process). But in practice, recovery may be faster because:
- Multiple responders can work in parallel on different forks
- The computation is known to be needed (strong demand signal)
- Aggregation of the new chain can proceed quickly

### Recovery Cost

The total cost of a chain cascade:
- L × bounty: the bounties paid for the invalidated chain
- L × computation_cost: the computation work that's thrown away
- Recovery time: the chain is stalled until re-published

This cost is borne by the network participants (requesters lose
bounties, responders lose time). The deceiver pays only their
FOR collateral (or earns the jackpot if self-catching).

### Is This Acceptable?

Compare to the non-chain case:
- Non-chain: one trap affects one block. Cost = one bounty.
- Chain: one trap affects L blocks. Cost = L bounties.

The chain amplifies the damage by factor L. But:
- L is bounded by how quickly the trap is caught. With active
  verification (E2's 0.1% fraud rate), most traps are caught
  within a few blocks of being published.
- The aggregation delay provides a buffer. Blocks aren't aggregated
  immediately, so the cascade depth before aggregation is limited.
- The economic damage per incident is bounded by L × bounty_per_block.

---

## Chain-Specific Deception Strategies

### Strategy 1: Trap Early in a Popular Chain

Place the trap at the beginning of a chain that will grow long.
The cascade affects many blocks, increasing aggregation damage
(and thus the self-catch jackpot, which comes from the aggregator's
collateral).

**Effectiveness**: High damage potential, but also high detection
probability — the early block is sampled more (the sampling module
gives priority to blocks with high descendant weight, and the
descendant dampening makes this LESS likely to be sampled... wait).

Actually, looking at the sampling formula from sampling.md:

```
dampening(T) = W / (W + D)
```

Where D is verified descendant weight. High descendant weight
REDUCES priority. So the trap block, which has growing descendants,
actually becomes LESS likely to be sampled as the chain grows.

This is a problem! The sampling module deprioritizes blocks with
established descendants, which is exactly where traps do the most
damage in chains.

**Mitigation**: The sampling module's descendant dampening assumes
that heavy descendants are evidence of authenticity ("if many people
built on it, it's probably real"). For computation chains, this
assumption is weaker — descendants are mechanical continuations, not
independent endorsements.

**Possible fix**: Weight descendant dampening differently for chain
blocks vs. independent blocks. Chain descendants (blocks that claim
the previous output in the same contract chain) provide less
authenticity evidence than independent blocks.

### Strategy 2: Trap at a Fork Point

Place the trap where the chain forks (e.g., where a game state
output has multiple claimants).

```
state_1 → state_2(trap) → state_3a (branch A)
                         → state_3b (branch B)
```

Both branches are invalidated. More damage per trap.

**Effectiveness**: Same as Strategy 1 but with wider cascade.

### Strategy 3: Trap in a Low-Value Chain

Place traps in chains where the bounty per block is low. The
deceiver's collateral cost (c) is fixed, but the damage is
proportionally lower. This makes deception less attractive in
low-value chains.

**Effectiveness**: Poor. The deceiver pays the same collateral
but the jackpot is smaller (aggregator stakes less on low-value
chains).

---

## Equilibrium Adjustment for Chains

The E2 equilibrium analysis assumed independent blocks. With chains,
the analysis changes:

### Publisher's Adjusted EV

A trap at chain position K that persists for L blocks before being
caught produces a cascade of depth L. The aggregator's collateral
at risk is proportional to the TOTAL weight of the cascade.

```
j_chain = j_single × amplification_factor(L)
```

Where amplification_factor depends on how much of the chain was
aggregated before the trap was caught.

If the aggregator aggregated the entire chain:
```
amplification_factor = L    (all L blocks in the subtree)
j_chain = L × j_single
```

This means chain traps are MORE profitable than non-chain traps!
The publisher risks the same collateral (c) but the potential jackpot
scales with chain length.

### Verifier's Adjusted EV

Verifiers catching chain traps earn the same reward (c) regardless
of chain length. The verification cost is the same (one re-execution).
So the verifier equilibrium is unchanged.

### Aggregator's Adjusted Risk

Aggregators face higher risk from chains because one trap invalidates
an entire chain worth of work. The expected loss per chain block:

```
expected_loss_per_block = f × c_aggregator
```

But with chains, a single fraud event causes loss across L blocks:
```
expected_loss_per_chain = L × f × c_aggregator  ???
```

No — the fraud event is one block. The loss is the aggregator's
collateral for the subtree containing that block. If the aggregator
aggregated the entire chain, one fraud event can cost them the entire
chain's worth of collateral.

**Implication**: Aggregators should be MORE cautious about aggregating
long chains. They should probe more aggressively in proportion to
chain length.

### Revised Aggregator Probing

For a chain of length L:
```
expected_fraud_blocks = L × f
probes_needed = enough to bound expected loss below fees
```

With f = 0.001 and L = 100:
```
expected_fraud_blocks = 0.1
probes_needed ≈ 5-10 (to push P(miss) below threshold)
```

The aggregator verifies a sample of the chain blocks. If they all
pass, the residual risk is bounded.

---

## Chain Checkpointing

One mitigation for cascade damage: periodic checkpoints.

### How Checkpoints Work

Every C blocks in a chain, a "checkpoint" block is published. The
checkpoint:
1. Verifies the previous C blocks (re-executes them all)
2. Publishes the verified state with enhanced collateral
3. Breaks the chain dependency: blocks after the checkpoint anchor
   to the checkpoint, not to the raw computation blocks

```
[ckpt_0] → state_1 → ... → state_C → [ckpt_1] → state_C+1 → ...
```

If state_K is a trap (where K < C), the cascade only reaches back
to ckpt_0, not further.

### Checkpoint Economics

The checkpoint publisher:
- Bears the cost of re-executing C blocks (C × V)
- Stakes enhanced collateral (covering C blocks worth of work)
- Earns a fee proportional to the verification provided

Checkpoints are aggregation-like: they consolidate risk and transfer
it from individual block publishers to the checkpoint publisher.

### Natural Checkpoints: Aggregation

Actually, aggregation IS checkpointing. When an aggregator rolls up
a chain, they (should) verify the chain and stake collateral on the
result. The aggregation block IS the checkpoint.

The proposal from E5 Phase 2 (computation chains) implicitly includes
this: aggregation of chain blocks verifies the chain.

So the chain cascade is bounded by aggregation frequency. If
aggregation happens every A blocks, the maximum cascade depth is
roughly A blocks.

---

## Design Recommendations

### 1. Sampling Module: Chain-Aware Priority

The sampling module should recognize computation chains and adjust
priority for chain head blocks (the earliest unverified block in a
chain):

```
chain_priority_boost(block) =
  if block is chain head AND has unverified descendants:
    boost = log(descendant_chain_length)
  else:
    boost = 0
```

This counteracts descendant dampening for chain blocks, ensuring
trap blocks don't become deprioritized just because a chain grew
on top of them.

### 2. Aggregation: Verify Chain Blocks Before Aggregating

Aggregators should fully verify computation chain blocks (not just
sample) before aggregating them:

```
For each chain block in the subtree:
  Re-execute the computation
  If any fail → exclude the subtree
```

This is more expensive than statistical sampling, but computation
chains have amplified risk. The aggregation fee should reflect this
cost.

### 3. Chain Depth Awareness in Collateral

Publishers deeper in a chain should consider the risk that earlier
blocks might be traps. Their computation is correct, but if an
ancestor is invalidated, their work is lost.

A chain-depth discount on collateral:
```
effective_collateral_requirement(depth) = base_collateral × (1 + depth_penalty)
```

Actually, this penalizes the wrong people (innocent chain publishers).
Better: the market naturally prices this in. Responders demand higher
bounties for deep chain positions because of the cascade risk. This
is emergent, not enforced.

### 4. Parallel Chain Forks for Resilience

For critical chains (game state), multiple parallel forks can be
maintained:

```
state_1 → state_2a (responder A)
        → state_2b (responder B)
```

Both compute the same next state (deterministic). The consensus
module picks one (by weight). If state_2a is a trap, state_2b
provides instant recovery — no need to re-compute.

This is expensive (double computation) but provides resilience
for high-value chains.

---

## Impact on the Overall Design

### What Changes

- **Sampling module** needs chain-awareness to boost priority for
  chain head blocks.
- **Aggregation probing** should be more thorough for chain blocks.
- **The deception game's equilibrium** is slightly shifted for
  chains: traps are more profitable (amplified jackpot) but also
  detectable through aggregation-time verification.

### What Doesn't Change

- **Program as contract** still works. Chains are a natural
  consequence of the model.
- **The core deception game** mechanics (insurance, self-catch)
  are unchanged.
- **Challenge/query separation** is unchanged.
- **The WASM interface** is unchanged.

### New Insight

**Aggregation IS chain checkpointing.** The aggregation mechanism
already provides the right tool for bounding cascade damage. The
protocol doesn't need a separate checkpointing mechanism — it just
needs aggregators to verify chains more thoroughly before aggregating.

This reinforces the aggregation speed-vs-safety tradeoff from
trust.md: for chains, the safety side of the tradeoff is more
important, and aggregators should probe more.

---

## Comparison with E1-E5

### vs. E2 (Deception Game)

E2 analyzed independent blocks. This exploration extends the analysis
to chains, finding:
- Traps in chains are more profitable (amplified jackpot)
- Detection probability per trap is unchanged
- Cascade damage is bounded by aggregation frequency
- The equilibrium is still self-correcting but aggregators face
  higher risk

### vs. E4 (WASM Interface)

E4 introduced self-perpetuating chains without analyzing cascade
dynamics. This exploration identifies the sampling priority problem
(descendant dampening deprioritizes trap blocks) and proposes
chain-aware priority boosting.

### vs. E5 (Critical Review)

E5 proposed phased prototyping. This exploration suggests that
Phase 2 (computation chains) should include chain-aware sampling
from the start, rather than adding it later.

---

## Summary

Computation chains amplify deception damage but are bounded by
aggregation:

1. **Cascade depth = aggregation interval.** Once a chain is
   aggregated, the aggregation block serves as a checkpoint.
   Traps before the checkpoint don't affect blocks after it.

2. **Sampling needs chain-awareness.** Descendant dampening
   deprioritizes chain head blocks. A chain-priority boost ensures
   trap blocks are sampled even as chains grow.

3. **Aggregators should verify chains more thoroughly.** The
   amplified risk justifies higher probing rates for chain blocks.

4. **Innocent chain publishers are NOT penalized.** Non-canonical
   reclaim returns their collateral. They lose only opportunity cost.

5. **The equilibrium adjusts.** Chain traps are more profitable
   (higher jackpot from amplified cascade), which increases the
   fraud rate for chains, which increases verification activity for
   chains. The self-correcting dynamic still holds.

6. **Parallel forks provide resilience** for critical chains, at
   the cost of double computation.
