# Collateral Resolution

Two contracts handle block validity incentives: the **Verifier Reward Contract** (Type 1) and the **Rectification Contract** (Type 2). They are separate contracts with separate outputs because they have different owners, lifecycles, transfer semantics, and claim conditions.

For the economic model and equilibrium analysis, see [deception](deception.md). For the collateral structure and trust module, see [trust](trust.md).

---

## Why Two Contracts

| Property | Verifier Reward (Type 1) | Rectification (Type 2) |
|---|---|---|
| Owner | Publisher | Aggregator (via fee) |
| Lifecycle | Seconds (exponential decay) | Hours to days (persistent) |
| Transfers on aggregation? | No -- stays with publisher | Yes -- aggregator claims it |
| Claim trigger | AGAINST challenge | Proven invalidity |
| Purpose | Incentivize fast responses, deter data hiding | Make victims whole, fund finder's reward |

If these were a single output, every aggregation would need to partially claim and split it -- the aggregator takes Type 2 responsibility but can't touch Type 1. Two outputs keep aggregation clean: the aggregator claims the fee output and ignores the verifier reward.

---

## Contract 1: Verifier Reward

Posted by the publisher for each block. High initially, decays exponentially back to the publisher.

### Output

```
Verifier Reward output:
  verifier: { contract: VERIFIER_REWARD_CONTRACT, params: encode(target_block_hash) }
  value: C1  (proportional to throughput)
  detail: encode(publisher_pubkey)
```

### Spending Conditions

**Decay return** -- Publisher reclaims the decayed remainder after the block is no longer actively challenged:

```
return_amount = C1 * exp(-c * (now - block_timestamp))
```

The publisher must prove no active AGAINST challenges exist on this target. Requires `require_signature(publisher_pubkey)`.

**Challenge claim** -- A successful AGAINST challenge was posted and not responded to. The challenger claims the decayed remainder:

```
claim_amount = C1 * exp(-c * (challenge_timestamp - block_timestamp))
```

The reward is locked at the time the challenge was posted, not at resolution time. This prevents the reward from decaying further while waiting for a response.

**Non-canonical reclaim** -- Target block became non-canonical (lost a consensus race). Full C1 returned to publisher. No penalty for losing a fair race.

### Decay Formula

```
reward(t) = C1 * exp(-c * (now - block_timestamp))
```

- `C1`: initial verifier reward (proportional to throughput T)
- `c`: decay constant (~0.2-0.3/s, half-life ~2-3s)
- No explicit deadline. The decay IS the deadline. After ~30s the reward is negligible.

### Responsibility

The original publisher remains responsible for Type 1 forever. It never transfers. The publisher is incentivized to stay online because:
- Responding to AGAINST challenges earns the challenge bond (profitable).
- Failing to respond means their Type 1 decays to the challenger (costly).

If the publisher goes offline and the data is well-known, anyone can respond on their behalf -- the challenge bond is profitable for any responder, and the publisher's collateral is protected.

---

## Contract 2: Rectification Insurance

Posted by the publisher as the aggregation fee. Claimed by the aggregator during aggregation. Accumulates into the aggregator's rectification pot.

### Output (Initial -- Publisher Posts)

```
Rectification Fee output:
  verifier: { contract: RECTIFICATION_CONTRACT, params: encode(target_block_hash) }
  value: f = v * T / T_avg
  detail: encode(publisher_pubkey)
```

### Output (Accumulated -- Aggregator's Pot)

When the aggregator claims individual fee outputs, they roll them into a single rectification pot output covering the entire aggregation tree:

```
Rectification Pot output:
  verifier: { contract: RECTIFICATION_CONTRACT, params: encode(aggregation_tree_root) }
  value: sum(f_i for all covered blocks)
  detail: encode(aggregator_pubkey)
```

### Spending Conditions

**Aggregation claim** -- Aggregator claims the fee output when aggregating the target block. The aggregation contract requires the fee to be rolled into the aggregator's pot. This is normal output claiming -- no special logic.

**Rectification payout** -- A block in the covered tree is proven invalid. The contract creates:
- Finder's reward: `alpha * R` to whoever proved invalidity.
- Victim restoration: new outputs mirroring the incorrectly claimed outputs, making victims whole.
- Remainder stays in the pot (covering other blocks).

If the pot is smaller than the victim's total loss, the pot pays out what it can. This is an unfortunate but bounded situation -- it means the aggregator's insurance wasn't enough. Aggregator selection mechanisms (prioritizing aggregators with maximal collateral) mitigate this.

**Non-canonical reclaim** -- Full return if aggregation tree becomes non-canonical.

**Solidification return** -- After sufficient time without challenges, the aggregator reclaims the pot. The Bayesian risk decay makes old, unchallenged blocks overwhelmingly likely to be valid.

### Rectification Proof Chain

To trigger rectification, the claimant must prove:
1. A specific block B in the aggregation tree is invalid (resolved via Type 1).
2. The aggregation tree root covers B (traversable through the aggregation hierarchy).

The proof is the chain of aggregation references from the pot's target (tree root) down to the invalid block.

---

## Challenge Mechanism

### Challenge Target (Discriminated Union)

Every AGAINST challenge specifies what it contests:

```
ChallengeTarget =
  | { type: 'validity' }                    // WASM re-execution dispute
  | { type: 'anchor' }                      // anchor hash preimage
  | { type: 'ref', index: number }          // ref[index] hash preimage
  | { type: 'aggregate', index: number }    // aggregates[index] hash preimage
  | { type: 'output', index: number }       // outputs[index] content
```

### AGAINST Challenge Output

```
AGAINST output:
  verifier: { contract: CHALLENGE_CONTRACT, params: encode(target_block_hash) }
  value: bond
  detail: encode({ target: ChallengeTarget, challenger_pubkey: PublicKey })
```

The bond must be large enough to incentivize a response. The protocol does not set a minimum -- the market determines what's worth responding to.

### Hash Challenges (anchor, ref, aggregate, output)

Hash challenges are self-resolving. The hash either matches or it doesn't.

**Flow:**

1. Challenger posts AGAINST bond targeting a specific hash (e.g., `{ type: 'ref', index: 2 }`).
2. **Response**: Anyone with the preimage publishes a resolution block that claims the AGAINST output, providing the preimage in the block's detail. The challenge contract verifies `hash(preimage) == target_hash`. The responder earns the bond.
3. **No response**: The challenge goes unanswered. The block is considered invalid at this hash. The challenger can then claim the Type 1 verifier reward (decayed to the challenge timestamp).

```
Hash Response block:
  claims: [AGAINST_output]
  detail: encode(preimage)
  outputs: [{ SIGNATURE/responder, bond, empty }]
```

### Validity Challenges

Validity challenges contest the block's computational correctness -- the WASM execution produced wrong outputs.

**Flow:**

1. Challenger posts AGAINST bond with `{ type: 'validity' }`.
2. **Response**: The publisher (or anyone) re-executes the WASM and proves the output is correct. The exact proof mechanism depends on the contract's complexity:
   - For simple contracts: re-execute and compare outputs.
   - For complex contracts: may require a bisection protocol (interactive dispute).
3. **No response**: Same as hash challenges -- block is invalid, Type 1 decays to challenger.

Computational validity disputes are more complex than hash challenges because re-execution may be expensive. The bisection protocol (if needed) is a future extension. For now, the simple case (re-execute, compare) is sufficient for most contracts.

### Challenges as Queries

AGAINST challenges double as data queries. To traverse a block's subtree:

1. Post AGAINST on a hash you want to descend into (e.g., `{ type: 'ref', index: 0 }`).
2. The block creator (or anyone with the data) responds with the preimage, earning the bond.
3. The querier gets the data they wanted.

This makes graph traversal a paid protocol operation. Data providers are compensated for serving data. Verification and querying are the same operation.

### No Explicit Deadline

There is no challenge timeout. The verifier reward decay IS the implicit deadline:

- At t=0: full reward available. Strong incentive to challenge immediately.
- At t=3s: ~50% of reward remains. Still worth challenging.
- At t=30s: <0.1% remains. Not worth challenging.
- At t=minutes: effectively zero. Block is considered solidified.

For the responder, the same decay applies: respond immediately to protect your collateral. Delayed responses still work (the challenge bond is profitable regardless of timing), but the publisher's collateral is at risk the longer a challenge sits unanswered.

---

## Restoration Blocks

When rectification triggers, new outputs must be created to make victims whole. These restoration outputs are created in a standard block.

### Easy-Verify Whitelist

Restoration blocks use contracts from a protocol-maintained whitelist of **easy-to-verify** contract hashes. Easy contracts are trivially verifiable by any peer (signature checks, simple arithmetic). They do not require collateral because:

1. Verification is instant -- any peer can confirm correctness.
2. Invalid restoration blocks are simply ignored by all peers.
3. The cost of publishing an invalid restoration block (wasted effort, reputation damage) exceeds any possible gain.

The whitelist includes contracts like `SIGNATURE_CONTRACT` and the rectification payout contract itself. The protocol parameter controlling this whitelist is a set of contract hashes.

### Restoration Block Structure

```
Restoration block:
  claims: [rectification_pot_output]
  refs: [invalid_block, aggregation_tree_root]
  outputs:
    [0] { SIGNATURE/victim_pubkey, restored_amount, empty }    // victim restoration
    [1] { SIGNATURE/finder_pubkey, finder_reward, empty }      // finder's reward
    [2] { RECTIFICATION/tree_root, remaining_pot, agg_pubkey } // remaining pot
```

The rectification contract verifies:
1. The referenced block is proven invalid (Type 1 resolved against it).
2. The proof chain from the aggregation tree root to the invalid block is valid.
3. The restoration outputs correctly mirror the victims' lost outputs.
4. The finder's reward does not exceed `alpha * R`.
5. The remaining pot is returned to the aggregator.

---

## Interaction Between Contracts

A single invalid block resolution touches both contracts:

1. **Type 1 (Verifier Reward)**: The challenger posts AGAINST. No response. The verifier reward (decayed to challenge time) goes to the challenger.
2. **Type 2 (Rectification)**: The finder (may be the same challenger, or the self-flagging publisher) proves invalidity to the aggregator's rectification pot. Finder's reward + victim restoration outputs are created.

Self-flagging scenario:
1. Publisher creates invalid block B, posts Type 1 (C1) and Type 2 fee (f).
2. Aggregator includes B, claims the Type 2 fee, rolls into pot.
3. Publisher posts AGAINST on their own block. Type 1 is a wash (they're both poster and challenger).
4. Publisher triggers rectification. Profit comes from the finder's reward (`alpha * R`) from the aggregator's Type 2 pot.

---

## Open Questions

1. **Decay constant c**: c = 0.2-0.3/s gives a half-life of 2-3s. Needs empirical calibration.
2. **Minimum AGAINST bond**: Market-determined, but dust challenges could harass publishers. A minimum may be needed.
3. **Finder's reward fraction (alpha)**: Split between finder and victim restoration. Too small = nobody looks. Too large = victims not fully restored. Starting point: 50%.
4. **Bisection protocol for validity disputes**: Hash challenges are self-resolving. Complex WASM disputes may need interactive bisection. Deferred.
5. **Partial rectification pot claims**: When a single block is invalidated, how is the payout computed against the total pot covering many blocks? The pot needs bookkeeping for per-block coverage.
6. **Aggregator selection by collateral**: Mechanism for prioritizing aggregators that post maximal collateral. Deferred.

---

## Implementation

| File | Description |
|------|-------------|
| Future: `src/core/VerifierRewardContract.ts` | Type 1 contract: decay, challenge claim, non-canonical reclaim |
| Future: `src/core/RectificationContract.ts` | Type 2 contract: aggregation claim, rectification payout, solidification |
| Future: `src/core/ChallengeContract.ts` | AGAINST bond: hash response, validity response |
| [`src/core/TrustModule.ts`](../../src/core/TrustModule.ts) | Updates to integrate two-tier model and challenge lifecycle |
| [`src/core/Block.ts`](../../src/core/Block.ts) | New contract hashes: `VERIFIER_REWARD_CONTRACT`, `RECTIFICATION_CONTRACT`, `CHALLENGE_CONTRACT` |
