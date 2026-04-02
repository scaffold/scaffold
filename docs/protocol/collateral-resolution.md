# Collateral Resolution

Two contracts handle block validity incentives: the **Collateral Contract** and the **Insurance Contract**. Both are implemented as `ContractFn` functions using the `ContractEnv` interface.

For the economic model and equilibrium analysis, see [deception](deception.md). For the collateral structure and trust module, see [trust](trust.md).

---

## Terminology

- **Collateral**: Posted by the block author. Decays exponentially back to the author if unchallenged. If challenged (AGAINST), the decayed value goes to the challenger or responder depending on resolution. FOR and AGAINST are both collateral outputs with the same contract and params (target block hash), distinguished by their detail.
- **Insurance**: Posted by the block author as a deposit. Upon aggregation, most is returned to the author minus a risk transfer fee approximating the verification cost. The aggregator posts their own insurance covering the entire aggregated subtree.

---

## Why Two Contracts

| Property | Collateral | Insurance |
|---|---|---|
| Owner | Block author (permanent) | Author initially, then aggregator |
| Lifecycle | Seconds (exponential decay) | Hours to days (persistent) |
| Transfers on aggregation? | No -- stays with author | Yes -- aggregator claims, returns most, posts own |
| Mechanism | FOR/AGAINST challenge resolution | Risk transfer fee, rectification payout |
| Purpose | Incentivize fast responses, deter data hiding | Make victims whole, fund finder's reward |

---

## Contract 1: Collateral

Handles both FOR (publisher's stake) and AGAINST (challenger's bond) postings for a target block. All collateral for a given target shares the same verifier (`contract: COLLATERAL_CONTRACT, params: encode(target_block_hash)`), so `collectInputs()` returns all FOR and AGAINST postings.

### ContractEnv Hooks Used

- `getParams()` -- target block hash
- `getTimestamp()` -- current block timestamp (for decay computation)
- `collectInputs()` -- all visible FOR and AGAINST collateral for the target
- `requireOutput(verifier, value, detail)` -- distribute funds to winners
- `requireSignature(pubkey)` -- verify publisher identity for decay return

### Output Structure

```
Collateral output (FOR):
  verifier: { contract: COLLATERAL_CONTRACT, params: encode(target_block_hash) }
  value: C1  (proportional to throughput)
  detail: encode({ side: 'for', pubkey: publisher_pubkey })

Collateral output (AGAINST):
  verifier: { contract: COLLATERAL_CONTRACT, params: encode(target_block_hash) }
  value: bond
  detail: encode({ side: 'against', target: ChallengeTarget, pubkey: challenger_pubkey })
```

### Challenge Target (Discriminated Union)

Every AGAINST posting specifies what it contests:

```
ChallengeTarget =
  | { type: 'validity' }                          // WASM re-execution dispute
  | { type: 'anchor' }                            // anchor hash preimage
  | { type: 'ref', index: number }                // ref[index] hash preimage
  | { type: 'aggregate', index: number }           // aggregates[index] hash preimage
  | { type: 'output_verifier_contract', index: number }  // outputs[index] verifier contract hash
```

### Spending Conditions

The collateral contract runs when a block claims collateral outputs. It uses `collectInputs()` to see ALL visible FOR and AGAINST postings for the target, then determines the resolution:

**Decay return** -- Publisher reclaims the decayed remainder when no AGAINST challenges exist:

```
return_amount = C1 * exp(-c * (now - block_timestamp))
```

The contract checks `collectInputs()` for any AGAINST postings. If none exist, the FOR value (decayed) is returned to the publisher via `requireOutput()`.

**Hash challenge response** -- Someone responds to an AGAINST by providing the hash preimage. The contract verifies `Hash.digest(preimage) == challenged_hash`. The AGAINST bond goes to the responder. The FOR collateral is unaffected.

The preimage is provided via `requireResult()` on the resolution block.

**Unresolved challenge** -- An AGAINST challenge exists and the responder also claims the FOR collateral. The contract computes the decayed FOR value locked at the AGAINST posting's timestamp:

```
claim_amount = C1 * exp(-c * (challenge_timestamp - block_timestamp))
```

The challenger gets the decayed FOR value plus their own bond back.

**Non-canonical reclaim** -- Target block became non-canonical. Full value returned to both FOR and AGAINST posters. No penalty for losing a consensus race.

### Decay Formula

```
reward(t) = C1 * exp(-c * (now - block_timestamp))
```

- `C1`: initial collateral (proportional to throughput T)
- `c`: decay constant (~0.2-0.3/s, half-life ~2-3s)
- No explicit deadline. The decay IS the deadline. After ~30s the reward is negligible.

### Hash Challenges as Queries

AGAINST challenges double as data queries. To traverse a block's subtree:

1. Post AGAINST on a hash (e.g., `{ type: 'ref', index: 0 }`).
2. The block creator (or anyone with the data) responds with the preimage, earning the bond.
3. The querier gets the data they wanted.

Graph traversal is a paid protocol operation. Verification and querying are the same operation.

### Validity Challenges

Validity challenges (`{ type: 'validity' }`) contest the block's computational correctness. Resolution requires WASM re-execution rather than hash preimage reveal. For simple contracts, re-execute and compare outputs. Complex contracts may need a bisection protocol (future extension).

---

## Contract 2: Insurance

Handles the risk transfer between block authors and aggregators. The author posts insurance as a deposit; the aggregator claims it, returns most of it, and posts their own larger insurance.

### ContractEnv Hooks Used

- `getParams()` -- target block hash or aggregation tree root
- `collectInputs()` -- insurance outputs for the target
- `requireOutput(verifier, value, detail)` -- return to publisher, aggregator payout, rectification
- `requireSignature(pubkey)` -- verify identity
- `fetch(verifier, key)` -- check collateral resolution outcome for a target block

### Output Structure

```
Insurance output (author posts):
  verifier: { contract: INSURANCE_CONTRACT, params: encode(target_block_hash) }
  value: 1000  (proportional to throughput)
  detail: encode({ pubkey: author_pubkey })

Insurance output (aggregator posts):
  verifier: { contract: INSURANCE_CONTRACT, params: encode(aggregation_tree_root) }
  value: 2500  (covers entire aggregated subtree)
  detail: encode({ pubkey: aggregator_pubkey })
```

### Aggregation Claim Flow

When an aggregator includes block B in their tree:

1. Aggregator claims B's insurance output (value 1000).
2. Contract requires output of 995 back to original author (returning the deposit minus fee).
3. The aggregator keeps the fee (5 = v * T / T_avg).
4. The aggregator posts their own insurance output covering the entire subtree (value 2500).

```
Aggregation block:
  claims: [B_insurance_output, ...]
  outputs:
    [0] { SIGNATURE/author_pubkey, 995, empty }           // return to author
    [1] { INSURANCE/tree_root, 2500, aggregator_pubkey }   // aggregator's insurance
    [2] { AGGREGATION/..., 0, aggregation_data }           // aggregation output
```

The fee (`5 = 1000 - 995`) funds the aggregator's risk. The aggregator's own insurance (2500) comes from their own capital, covering the expected rectification liability for the entire tree.

On re-aggregation, the same process repeats: the re-aggregator claims the 2500, returns most of it to the original aggregator minus a fee, and posts their own larger insurance.

### Rectification Payout

When a block in the insured tree is proven invalid (via collateral resolution):

1. The finder proves invalidity by referencing the resolved collateral outcome via `fetch()`.
2. The insurance contract creates:
   - Finder's reward: `alpha * R` to whoever proved invalidity.
   - Victim restoration: outputs mirroring the incorrectly claimed outputs.
   - Remaining insurance stays in the pot.

If the pot is smaller than the victim's total loss, it pays what it can.

### Solidification Return

After sufficient time without challenges, the aggregator reclaims their insurance. Bayesian risk decay makes old, unchallenged blocks overwhelmingly likely to be valid.

### Non-Canonical Reclaim

Full return if aggregation tree becomes non-canonical.

---

## Restoration Blocks

When rectification triggers, new outputs are created to make victims whole. These restoration outputs are created in a standard block.

### Easy-Verify Whitelist

Restoration blocks use contracts from a protocol-maintained whitelist of **easy-to-verify** contract hashes. Easy contracts are trivially verifiable by any peer (signature checks, simple arithmetic). They do not require collateral because:

1. Verification is instant -- any peer can confirm correctness.
2. Invalid restoration blocks are simply ignored by all peers.
3. The cost of publishing an invalid restoration block exceeds any possible gain.

---

## Interaction Between Contracts

A single invalid block resolution touches both contracts:

1. **Collateral**: Challenger posts AGAINST. No response. The collateral (decayed to challenge time) goes to the challenger.
2. **Insurance**: The finder proves invalidity to the aggregator's insurance. Finder's reward + victim restoration outputs are created.

Self-flagging scenario:
1. Author creates invalid block B, posts collateral (C1) and insurance (1000).
2. Aggregator includes B, returns 995 to author, keeps 5 fee, posts own insurance (2500).
3. Author posts AGAINST on their own block. Collateral is a wash (they're both poster and challenger).
4. Author triggers rectification against the aggregator's insurance. Profit comes from the finder's reward (`alpha * R`).

---

## Open Questions

1. **Decay constant c**: c = 0.2-0.3/s gives a half-life of 2-3s. Needs empirical calibration.
2. **Minimum AGAINST bond**: Market-determined, but dust challenges could harass publishers. A minimum may be needed.
3. **Finder's reward fraction (alpha)**: Split between finder and victim restoration. Too small = nobody looks. Too large = victims not fully restored. Starting point: 50%.
4. **Bisection protocol for validity disputes**: Hash challenges are self-resolving. Complex WASM disputes may need interactive bisection. Deferred.
5. **Partial insurance claims**: When a single block is invalidated, how is the payout computed against the total insurance covering many blocks? Needs bookkeeping for per-block coverage.
6. **Aggregator selection by insurance level**: Mechanism for prioritizing aggregators that post maximal insurance. Deferred.
7. **UTXO priority for collateral claims**: Blocks claiming more collateral inputs should have priority. The exact priority mechanism (block-level or contract-level) needs specification.

---

## Implementation

Both contracts are `ContractFn` functions using `ContractEnv`. A `getTimestamp()` hook is added to `ContractEnv` for decay computation.

| File | Description |
|------|-------------|
| [`src/core/CollateralContract.ts`](../../src/core/CollateralContract.ts) | Collateral contract: FOR/AGAINST, decay, hash preimage, validity |
| [`src/core/InsuranceContract.ts`](../../src/core/InsuranceContract.ts) | Insurance contract: aggregation claim, rectification, solidification |
| [`src/core/ContractEnv.ts`](../../src/core/ContractEnv.ts) | `getTimestamp()` hook for decay computation |
| [`src/core/Block.ts`](../../src/core/Block.ts) | `COLLATERAL_CONTRACT`, `INSURANCE_CONTRACT` hashes. ChallengeTarget, CollateralDetail, InsuranceDetail types. Encode/decode helpers. |
