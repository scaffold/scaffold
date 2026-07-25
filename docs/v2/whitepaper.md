# Scaffold

## 1. Abstract

Scaffold is a protocol for trusted distributed computation. Work is published as blocks, which are accepted optimistically and organized into a balanced forest by aggregators. Aggregators sample random blocks in the tree to evaluate its risk, and if they're confident they insure the tree. There's always an active insurance for any given block; if an aggregator finds a fault (invalid computation, double-spend, etc), they present a proof to the currently active insurance and receive a reward. The failing block is disqualified and its throughput burned to allow another claim on the incorrectly claimed outputs. Consensus weight is real, measured verification cost, estimated by unbiased sampling and evaluation of the sampled blocks. The balanced forest gives O(log N) claim resolution, inclusion proofs, and trust decisions. The result is a protocol light enough for browsers to achieve fast consensus.

## 2. Introduction

Scaffold is a protocol enabling trusted distributed computation: a client wants to rely on the result of a computation it did not run.

The classical answer is replication. Blockchains have every validator re-execute every transaction, which makes trust unconditional but caps global throughput at the capacity of a single validator and prices every computation at N times its actual cost. The optimistic answer is verify-by-exception: accept results by default, let anyone challenge, and punish provable faults — the approach of optimistic rollups and Truebit-style verification games.

Scaffold prices the risk associated with possibly invalid blocks instead of mandating validity. Every block pays a fee on the order of its own verification cost. Aggregators admit blocks into the canonical structure by posting insurance over them, without necessarily requiring that the entire tree is valid. Probers sample subtrees hunting for faults and are paid out of that insurance when they find one — and the supply of faults is itself endogenous: rational authors occasionally publish invalid blocks precisely to farm insurers who didn't probe, and this deception game (§7) is what keeps verification funded when organic faults are rare. Crucially, a discovered fault does not unwind the ledger: the faulting block is disqualified, the output it claimed is freed to be claimed again, and the insurance burns the block's throughput so that total value stays conserved (§5). Work honestly built on top of a fault is left alone. Trust in a block is therefore a quantitative statement — how much verified weight is stacked on it, and how much insurance stands behind it — rather than a binary statement about validation.

Why a forest instead of a chain: a chain serializes all work through a single proposer, so consensus bandwidth bounds total throughput. In Scaffold, blocks form trees by aggregation — each block is aggregated exactly once, similar-sized trees are merged into larger trees, without bound — and the trees are stitched together by anchors (§4.2). There is no global bottleneck because consensus never examines every block: ordering is structural (§4.4), weight is estimated by sampling (§6), and validity is enforced by exception (§5). These balanced trees are what makes everything cheap: proofs, claim resolution, and trust decisions are all O(log N).

The storage space required from a node is also O(log N); most blocks can be forgotten freely once its short-term insurance has evaporated.

Compared to optimistic rollups, there is no distinguished sequencer and no L1 to appeal to — the challenge game and its collateral _are_ the base layer. There is also no fixed challenge window: detection probability compounds as weight accumulates, and insurance prices the residual risk (§8). Compared to Truebit, disputes resolve through a simple voting system rather than an interactive on-chain referee.

## 3. Model and assumptions

> ✍️ **TODO(you):** this section is new; it's my consolidation of the design's implicit assumptions. Review each — 3.4.2 in particular is currently the weakest formal link in the paper.

### 3.1 Participants

- **Authors** create blocks: they claim outputs, satisfy contracts, perform the actual computation, and attach an aggregation fee.
- **Aggregators** claim the aggregation outputs of similarly-sized trees, posting insurance over the subtrees they merge, and earn fees (§7).
- **Probers** sample subtrees, verify blocks, and hunt for faults in exchange for rewards. Probing is not a standalone profession: at equilibrium, random third-party bounty hunting is unprofitable (Appendix E), and detection lives with the aggregator probing before risk transfer, the strategic deceiver self-reporting at it, and the victim challenging after it (§7, §8.1).
- **Clients** resolve claims and decide trust from a block's aggregation chain and its visible insurance — O(log N) work, never re-execution (§11).

The roles overlap freely; a single node typically acts as all four.

### 3.2 The Joule

Scaffold's native token is the Joule. It serves double duty as the unit of value (outputs, fees, insurance) and the unit of weight: verification cost — CPU time of the WASM, memory, other resources — is evaluated in Joules (§6.1). The identification is deliberate: every security argument in §6 and §10 reduces to comparing a computation cost against a token amount, and a shared unit keeps those comparisons honest. All amounts in this paper are Joules.

### 3.3 Peer model

Peers gossip blocks; a block is a signed, immutable byte array addressed by hash. Peers execute WASM to generate and verify blocks. Peers connect over WebRTC and WebSocket, although the protocol leaves this open to extension. All peers have the same privileges; server-class peers may exist for performance but have no extra protocol capabilities.

Peers synchronize by connecting to at least one trusted peer. Peers should be able to persist blocks locally, notably blocks and aggregators containing their pending UTXOs. Although aggregators are incentivized to serve UTXOs it is not required. Long-term, most blocks are expected to be forgotten.

### 3.4 Adversary model

The adversary is byzantine and capital-bounded: it can author arbitrarily invalid blocks and aggregations, double-spend, misdeclare weights and throughputs, withhold data, and reorder, but it cannot forge hashes and cannot prevent honest peers from gossiping with one another. Safety is economic and rests on two assumptions:

1. **Detection.** Every fault class has a _situated, paid_ detector: aggregators probe before insuring, strategic deceivers self-report at the moment of risk transfer, and victims challenge claims on their own outputs (§7, §8.1). No fault class may rely on unpaid altruism — random third-party bounty hunting is structurally unprofitable at equilibrium (Appendix E) — so §8.3's detection-delay distribution must be justified from these paid channels alone.
2. **Honest weight.** The adversary cannot sustainably out-spend the honest economy on verified weight for a contested claim.

!!! TODO: Revisit

> ✍️ **TODO(you):** assumption 2 needs a precise form — it's the analog of Nakamoto's honest-majority-hashpower assumption, but localized per conflict. What's the right bound: honest weight-generation rate on the contested branch exceeds the attacker's, for long enough that penalties dominate?

### 3.5 What "trusted" means

Scaffold does not guarantee that every canonical block is valid. It guarantees:

1. **Conservation.** Under the canonical view, inputs equal outputs at every block, and total supply equals issuance minus burns — always, even while faults sit undiscovered (§5.2).
2. **Rectification.** Any fault in an insured subtree, once detected, is disqualified: the output it claimed becomes claimable again, the finder is rewarded, and the discrepancy is burned out of insurance (§5.4, §8).
3. **Succinct trust.** A client's trust decision for a block requires only its aggregation chain and the insurance visible on it (§11).

A deeply buried, insured block is trustworthy not because someone likely validated it, but because enough value stands behind its validity that any fault would have been profitable to report.

## 4. Data structures

### 4.1 Blocks

The atomic unit in scaffold is a block. A block is an immutable byte array, typically represented by its hash. A block has a number of properties, and looks something like this:

```typescript
interface Block {
  anchor: Hash;
  chain: { weight: bigint; throughput: bigint }[];
  aggregates: { block: Hash; outputCount: bigint }[];
  claims: bigint[];
  refs: bigint[];
  outputs: {
    contractHash: Hash;
    params: bytearray;
    data?: bytearray;
    amount: bigint;
  }[];
  timestampMs: number;
}
```

**Outputs.** An output describes funds that are only able to be retrieved by a block satisfying the given contract and parameters. Amount must be non-negative (although relaxing this restriction has some interesting mechanics we could investigate in the future — §13). Contract semantics, `ALLOWED_PRODUCERS`, and the `stalling` flag are covered in §9. The conservation rule on outputs is in §5.2.

**Timestamp.** This must be greater than or equal to the timestamps of the anchor and all aggregated blocks. Time semantics and time-locks are covered in §9.7.

**Serialization, signing, and identity.** A block's fields are serialized into a byte array (not necessarily canonically); the author signs a digest of those bytes and the signature is appended; the block hash is the hash of the serialized fields and the signature. The author's public key can be recovered from the signature, which means every block carries an unforgeable binding to the key that produced it.

**Blocks are immutable.** Changing any field requires a new signature, and both the change and the new signature change the hash. Any modifications produce a new block.

### 4.2 Anchors and the anchor chain

The anchor is a hash to another, larger block. Following anchors recursively gives the anchor chain: a sequence of tree roots increasing in size, terminating at the genesis block, which is defined to have infinite size. A block's **reach** is what that chain makes addressable — its own tree (§4.3), plus the tree of every block on the chain. Reach is what the anchor exists to buy, and everything a block is structurally responsible for has to fall inside it:

1. Every output it claims or references, so that §4.5 can resolve the index.
2. The anchor of every block it aggregates.

The first is the obvious one: you cannot spend what you cannot name. The second is what makes reach compose. A block inherits its aggregates' claims — it has to sum their throughput into its chain array, below — so it needs to see whatever they saw. Constraining only each aggregate's anchor suffices, because every aggregate imposed the same rule on its own aggregates; applied down the tree, it guarantees that every claim made anywhere inside a block's tree resolves inside that block's reach. Without it a buried block could claim from a tree its aggregator cannot see, and throughput the aggregator is obliged to declare would have nowhere to land.

Reach only grows as you anchor: a block inherits its anchor's reach and adds its own tree. The flip side is that two blocks in different trees that nothing has merged yet are in nobody's reach at once, so a block wanting to claim from both simply waits for the aggregation that merges them (§7).

> ❓ **Open (terminology):** "size" is used loosely across the paper — here, in the 60% rule (§7), and in "similarly-sized". Pick one definition (weight? block count? output count?) and use it exactly; see Appendix D.

**The chain array.** The chain array specifies different properties of blocks in the anchor chain. `chain[0]` refers to the anchor. `chain[1]` refers to anchor.anchor, and so on. Beyond the end of the array, any remaining anchor chain blocks implicitly receive `{weight: 0, throughput: 0}`. Knowing that a tree doesn't claim any coins from an anchor chain link is actually pretty useful, because it lets walkers skip subsets of the tree that don't claim anything from outside a larger tree (§11.3).

**Weight** refers to the amount of work descendant of that chain entry (by anchor). Basically, for every block in the subtree (excluding the root itself), propagate its work to its anchor until it reaches a chain entry. Then it's placed into the `weight` property at that position. Example:

- The anchor chain is G <- A <- B <- C
- B aggregates B0 and B1
- A <- B0 <- B1 (B0 anchors A and B1 anchors B0)
- C aggregates C0, C1, and C2
- C0 has work 5 and anchors B0
- C1 has work 12 and anchors B1
- C2 has work 50 and anchors B
- THEN C's weight chain would be `[{weight: 50}, {weight: 17}]`

Walking the propagation explicitly:

- C2 anchors B. B is on C's anchor chain, at position 0, so C2's 50 lands in `chain[0]`.
- C0 anchors B0. B0 is _not_ on C's anchor chain, so the work propagates to B0's own anchor, A. A is `chain[1]`, so the 5 lands there.
- C1 anchors B1 → B1's anchor is B0 → B0's anchor is A: `chain[1]` again, adding 12.
- If it had any, C's work would not be included.
- Hence `[{weight: 50}, {weight: 17}]`. In general: each subtree block's work walks up _its own_ anchor chain until it first hits a block on the root's anchor chain, and is attributed at that position.

**Throughput** refers to the amount of coins claimed from the tree represented by that root. Example:

- The anchor chain is G <- A <- B <- C
- A aggregates A0 and A1
- C aggregates C0 and C1
- C0 claims 5 coins from A0
- C1 claims 12 coins from B1
- THEN C's throughput chain would be `[{throughput: 12}, {throughput: 5}]`

Walking it: `chain[0]` covers claims from B's tree, which is {B, B0, B1} (B aggregates B0 and B1 — trees are formed by aggregation, not anchoring, so A is not in it). C1's 12 from B1 lands there. `chain[1]` covers A's tree {A, A0, A1}; C0's 5 from A0 lands there. Trees of distinct anchor-chain roots are disjoint (every block is aggregated exactly once), so the attribution is unambiguous.

### 4.3 Aggregation and the forest

Every block is aggregated exactly once, which means its hash is included in exactly one other block's aggregates array. This forms a tree structure. We say a tree T "includes" another block B if either T === B or at least one (there should only be one) of T's aggregates includes B. This is a recursive definition and informally simply reports whether B is contained in the aggregation tree of T.

Care is taken to aggregate similarly-sized trees, ensuring the tree is balanced. As we will see, this gives us O(log N) proofs and queries in a number of areas.

The aggregates array is used solely to look up claims (§4.5). The aggregation output of each of the aggregated blocks must be claimed, and only those aggregation outputs. If there's N aggregates, there must be N claimed aggregation outputs. The `outputCount` is the total number of outputs created by the entire subtree, which may be claimed or unclaimed. It must be the sum of the aggregated block's output array length and each of its own aggregate's `outputCount`. A correct `outputCount` is what keeps claim resolution tree-scoped (§4.5), so mis-declaring it is a hard fault (§5.1).

The aggregates array should be ordered in order of descendant weight, highest to lowest (the penalty for misordering is in §5.3 and Appendix C). The mechanics and economics of _creating_ aggregations are in §7.

### 4.4 The canonical ordering

The anchor -> subtrees -> self gives the canonical ordering of the graph represented by a block S:

```python
def traverse_tree(block: Block):
    for agg in block.aggregates:
        yield from traverse_tree(agg.block)
    yield block
def traverse_graph(block: Block):
    if not is_genesis(block):
        yield from traverse_graph(block.anchor)
    yield from traverse_tree(block)
```

This ordering is what assigns priority among conflicting claims: the first spend of an output in canonical order is the legitimate one, and all later spends are disqualified (§6.4).

### 4.5 The global output space and claims

A claim signifies that the block fulfills the contract and parameters specified by the referenced output. A claim is an index, and is resolved recursively by this formula:

```typescript
function resolveClaim(
  block: Block,
  claim: bigint,
): { block: Block; outputIndex: number } {
  const outputCount = BigInt(block.outputs.length);
  if (claim < outputCount) {
    return { block, outputIndex: Number(claim) };
  }
  claim -= outputCount;

  for (const agg of block.aggregates.toReversed()) {
    if (claim < agg.outputCount) {
      return resolveClaim(resolveBlock(agg.block), claim);
    }
    claim -= agg.outputCount;
  }

  return resolveClaim(resolveBlock(block.anchor), claim);
}
```

This is equivalent to indexing into the following implicit output space defined wrt a block:

```python
def generate_tree_space(block: Block):
    yield from block.outputs
    for agg in reversed(block.aggregates):
        yield from generate_tree_space(agg.block)
def generate_output_space(block: Block):
    yield from generate_tree_space(block)
    if not is_genesis(block):
        yield from generate_output_space(block.anchor)
def resolve_claim(block: Block, claim: int):
    return list(generate_output_space(block))[claim]
```

Note the output space is ordered, with more recent outputs having lower indices and older outputs having higher indices. Immediately claiming an output on the same block is possible; this is called a self-claim.

> 💡 **Invariant (tree-scoped resolution):** when `resolveClaim` recurses into an aggregate, the guard `claim < agg.outputCount` guarantees the recursion resolves _within that aggregate's tree_ and never falls through to the aggregate's anchor — provided `outputCount` is declared correctly. That is exactly why `outputCount` correctness is a validity rule (§5.1), and it's what makes the TypeScript resolver equivalent to `generate_output_space` (whose tree recursion is structurally anchor-free). `resolveBlock` is assumed content-addressed lookup by hash.

Alternative claim addressings (block hash + index; `{chainHops, treePath, outputIndex}` tuples; indexing the _unclaimed_ vector) were considered and rejected — see Appendix B for the designs and why.

### 4.6 The merkle claimed/unclaimed mask

Indexing the _unclaimed_ output vector (Appendix B, option 4) would have made double-spends unaddressable, at the cost of heavy claim-mask machinery in every client. Option 3 omits this necessity, since it indexes into a global output vector, containing both claimed and unclaimed outputs. The transformation from one block's output space into another's is a simple addition.

Detecting double-spends was a big benefit of the claim mask. This is mostly useful for aggregation, when an aggregator wants to know that he won't have to pay out double-spend claims. We can still do this, keeping a claimed/unclaimed bitvector in a merkle tree on each block, without affecting claim lookups.

It's very simple; each block's merkle tree encodes a bitvector with a 1 set if that output index is claimed in an aggregate. The bitvector's length is `anchor.output_space_size + SUM(aggregate[*].created_outputs)`. Notably it does not include outputs or claims of the block itself. The merkle tree root is stored in the aggregation output data.

There are two access paths, and they never meet: **light clients** resolve claims purely additively through the output space and never touch the mask; **aggregators** maintain the mask to detect double-spends before posting insurance (§7), and prove claimed/unclaimed status against it when contests need it.

### 4.7 Refs

Whereas claims point only to unclaimed outputs, refs point to any output. They act as a kind of "activity log" allowing reproducability for the data fed to the contract. The exact semantics of this are still unspecified.

## 5. Validity and faults

### 5.1 Validity rules

A block is valid iff:

1. **Structure.** Its anchor points to a larger tree than itself; every block it claims or references, and the anchor of every block it aggregates, lies in its reach (§4.2); its timestamp is ≥ the timestamps of its anchor and all aggregated blocks.
2. **Conservation.** The sum of its output amounts exactly equals the sum of its claimed output amounts (§5.2).
3. **Contracts.** Every claim satisfies the claimed output's contract and parameters (§9); `ALLOWED_PRODUCERS` restrictions are respected; if it aggregates or anchors a stalled block, it claims all of that block's stalling outputs (§9.6).
4. **Aggregation correctness.** Its aggregates' `outputCount`s and its chain array's weights and throughputs are correctly summed; each aggregated tree is smaller than 60% of the aggregate (§7); no block appears twice (structurally excluded anyway — the duplicate's aggregation output would be double-spent).

Ordering of the aggregates array (heaviest-first, §4.3) is deliberately _not_ a validity rule — misordering is a soft penalty (§5.3).

### 5.2 Conservation and burns

The sum of output amounts must exactly equal the sum of claimed output amounts. The aggregation fee is itself just an output (addressed to the aggregation contract, §7), so conservation is block-local and needs no special cases.

Faults create discrepancies, and the v2 rule is that a discovered fault does not invalidate the aggregation containing it. Misdirected funds — a block invalidly claiming an output, or the loser of a double-spend — are disqualified, which frees the claimed output to be spent a second time, and the insurance burns the disqualified block's throughput to keep total value constant. Work built downstream of the fault is left alone; the burn pays for its keep.

### 5.3 Fault taxonomy

**Hard faults** disqualify a block, burn its throughput, and pay the finder out of insurance (§8):

- **Invalidity.** The block fails verification — a claim doesn't satisfy its contract, or a rule of §5.1 is broken.
- **Double-spend.** More than one block claims the same output. All spends following the first one (in the canonical traversal of the tree) are disqualified. A double-spend is an invalidity _of the aggregator_: the fault is attributed to — and paid by the insurance of — the aggregation that admitted the later claim.
- **Uninsured aggregation.** If an aggregator A does not correctly sum the throughputs of its aggregated blocks, we say the aggregated blocks are "uninsured". The aggregator A fails validation, is disqualified, and the aggregated blocks may be aggregated again. This simply falls out of the invalidity logic, but it should be noted that once an aggregator has been disqualified (fails validation or double-spends), the path is broken: its children and grandchildren are no longer eligible to claim insurance. Although this should hold for all kinds of disqualifications, the most important one is if throughput is not correctly summed. This should be clearly visible from the aggregation path, and any paths without correctly summed throughput are simply invalid. If this did not hold, a very large sub-block could be "hidden" inside an aggregation with low declared throughput, meaning it's never probed; this large sub-block should not be eligible to claim insurance payouts (§10.7).

**Soft penalties** reduce canonicality without disqualification:

- **Misordering.** Aggregates not ordered heaviest-first. A misordered aggregation is treated similarly to a disqualification for canonicality purposes, although its disqualification doesn't get aggregated like an invalidity or double-spend does.

### 5.4 Disqualification semantics and claim regeneration

Locally, a peer should give each claim a canonicality of `descendant_weight + self_weight - disqualification_penalty - misordering_penalty` (developed in §6.3), where:

- `disqualification_penalty = IF(disqualified, throughput * disqualification_factor, 0)`
- `misordering_penalty = IF(misordered, throughput * misordering_factor, 0)`

> ❓ **Open:** the notes carry two forms of the misordering penalty — the simple `throughput * misordering_factor` in §5.4's canonicality formula, and the developed hinge penalty `U = Σ max(0, w_later − w_earlier)` with grounded semantics (Appendix C). Commit to one; I'd take the hinge — it prices exactly the orderer's marginal harm and is continuous in the weights, but its gap-freezing question (Appendix C) must be resolved first.

An invalid block or a double-spend loser gets marked "disqualified" in some aggregator. Then:

- Disqualified blocks are no longer eligible to be marked in a double-spend or as invalid — each block pays for at most one fault.
- The disqualified block's canonicality gets decremented by its throughput, which gets burned.
- Any negative canonicality is flagged and propagates to descendants, which makes the whole downstream uncanonical.
- A disqualified block doesn't participate in double-spends, so you can regenerate the claim: the new block behaves exactly the same as it would have if it had been generated originally.

> Note that although negative canonicalities propagate to descendants, invalidities don't. This is because lots of work could be built on an invalid block, and in this case we leave that work alone, while freeing up the original output to be claimed again. On the other hand if the descendant work doesn't exceed the throughput, the canonicality will become negative and that WILL propagate downstream, effectively making the whole branch uncanonical.

### 5.5 Rectification economics

The incentive structure must satisfy:

```
generation_cost + verification_cost <= throughput <= rectification_amount
```

The `rectification_amount` should be approximately equal to the value of a correct solution minus the value of an incorrect solution.

Invalidity insurance payout:

- Burn `throughput` -> `{disqualify, block_hash}`, which disqualifies the block
- Pays `O(throughput)` for reward
- Note: the whole block's throughput is used, not just the claim

Double-spend insurance payout:

- Burn `throughput` -> `{disqualify, block_hash}`, which disqualifies the block
- Pays `O(throughput)` for reward
- Note: the whole block's throughput is used, not just the claim

Including or not including a double-spend depends on the fees. If the fees are large enough to compensate for the payout, we can include both.

> 💡 The reward is pinned as `α · throughput` for a protocol constant α (the finder's share), paid _on top of_ the burn: the insurer's total outlay per fault is `(1+α) · throughput`. Self-reporting your own fault is deliberately profitable when the insurer is someone else — that is the deception game, §7 — and never profitable against yourself, because self-aggregating and self-reporting still forfeits the burn, which is never recycled to any player. α is an equilibrium dial, not a safety constant: Appendix E.

## 6. Weight and consensus

> ✍️ This section is new. The estimator results in §6.2 are established (from the byzantine-sampling analysis) but their derivations live in notes, not here; §6.3 and §6.5 are genuinely open.

### 6.1 What weight is

A block's weight is its verification cost, evaluated in Joules: typically proportional to the CPU time taken to run the WASM, but it could also be based on memory usage or other resources. It's locally defined and may be noisy, but consistent weight evaluations across nodes are desired and will make consensus more efficient.

Weight is Scaffold's analog of proof-of-work: the scarce, physically real resource behind canonicality. Where PoW spends energy on hash preimages, Scaffold's weight is the cost of the useful computation itself, plus the cost of verifying it. Its two load-bearing properties:

1. It is verifiable by sampling — any peer can re-run a block and measure its cost.
2. It cannot be inflated by declaration (§6.2). Declared weights steer sampling; they never enter the estimate.

### 6.2 Sampling-based weight verification

Blocks are aggregated into trees. Trees can declare arbitrary weight, so instead of trusting it, peers sample and evaluate locally. Peers descend a tree by sampling, at each branch choosing children proportional to their aggregation fee. Once a leaf is reached, the peer verifies the block and measures the cost (cpu usage, memory, etc). This propagates back up the tree, scaling up by the inverse probability of sampling each child, until the root has an estimate. This can occur multiple times to get a more accurate measurement.

```python
def sampleSubtree(node, lam) -> Estimate:   # lam = budget knob
    est = Estimate.empty()                  # n=0, value 0  (additive identity)

    pi0 = inclusion_prob(node.declaredWeights[0], lam)
    if bernoulli(pi0):
        est += estimateSelf(node) / pi0

    for k, child in enumerate(node.children):
        pik = inclusion_prob(node.declaredWeights[k+1], lam)
        if bernoulli(pik):
            est += sampleSubtree(child, lam) / pik

    return est
```

This is a **per-slot Horvitz–Thompson estimator**: every slot — the node's own work and each child subtree — is gated behind an independent Bernoulli coin with inclusion probability π derived from its declared weight and the budget knob λ, and each included measurement is scaled by 1/π. The estimator is unbiased for the true total weight _regardless of the declarations_: E[X · 1{included} / π] = X. Declarations control only where the sampling budget goes, never the expectation.

That is the entire defense against byzantine declaration. Over-declaring a subtree's weight raises its inclusion probability — it gets probed more, its measured contribution is scaled down by the larger π, and (fees being proportional to declared cost) it pays more — with zero effect on the expected estimate. Under-declaring hides a subtree from probing, but forged declarations can only move variance and lose weight, never gain it. Two refinements follow directly:

- Estimates are carried as `{value, variance, n}` structs and composed, not bare scalars — composition, adaptive budget allocation, and confidence intervals all need the variance. Per-child sampling streams must be independent; a single shared descending path breaks the variance-sum identity.
- Peers credit a subtree its **lower confidence bound**, not its point estimate. This turns the adversary's only remaining lever — variance inflation — against them: any forged declaration widens the interval and reduces credited weight, making honest proportional declaration the unique credit-maximizing strategy (and the zero-variance point).

The one thing sampling cannot hide is money: throughput must be exactly summed up the aggregation chain (§5.3), so a large spend is visible in the chain array regardless of its declared weight. You can hide computation; you cannot hide value.

> ✍️ **TODO(you):** import from the sampling notes: the choice of `inclusion_prob` (e.g. π = min(1, λ·d)), the λ budget policy, sample counts before crediting, and the Hájek/ratio-estimator counterexample showing why the per-slot form is required (dividing by the covered declared fraction is exploitable by under-declaring heavy subtrees).
> ❓ **Open:** is `declaredWeights` the aggregation fees themselves, or a separate field? (§4.1)

### 6.3 Canonicality

Locally, a peer gives each claim the canonicality

```
canonicality = descendant_weight + self_weight - disqualification_penalty - misordering_penalty
```

where `descendant_weight + self_weight` is sampled, verified weight from descendant trees (§6.2), credited at the lower confidence bound, and the penalties are per §5.3–§5.4.

> ❓ **Open (carried from the notes):** how does descendant weight compose across aggregation — when a descendant is aggregated, is its work summed twice (once via its own subtree, once via the aggregate)? Current thinking: aggregate the _maximal cross-section of fees_ and use that as the weight. Needs formalization — this is the single definition §6.4 and §6.5 both stand on.
> ❓ **Open (terminology):** the note "the weight is proportional to throughput, so larger blocks will be prioritized" conflates the two units; if it means fees correlate with value-at-risk (per §7's fee curve), say that — and check it against §10.2.

### 6.4 Fork choice, ordering, fault assignment

Conflicts (§5.3) include competing aggregations of the same aggregation output — that is what a "fork" looks like in a forest. Fork choice is per-conflict: each peer prefers the claim with the highest canonicality. Because weight is measured cost, out-competing an established claim requires actually out-spending its accumulated descendants; in practice the first-published claim attracts descendants first and stays ahead — which is precisely what makes fast probing and publishing profitable for aggregators (§7).

Fork choice determines ordering: the winning aggregation's canonical traversal (§4.4). Ordering determines fault assignment: the first claim of an output in canonical order is legitimate; every later one is disqualified (§5.4). The pipeline is strictly fork choice → ordering → fault assignment, and faults feed back into fork choice only through the canonicality penalties.

### 6.5 Finality

Informally: a deeply buried block — lots of descendant weight, usually quite old — is canonical and would be very difficult to make uncanonical. Proposed formalization: a claim is **A-final** if no set of newly created blocks with total verified weight ≤ A can make a conflicting claim canonical. A-finality is monotone (weight only accumulates) and strictly economic — like Nakamoto finality, never absolute. Disqualification burns make reversal attempts strictly lossy rather than merely unprofitable: the attacker's competing claim, if it loses, is itself disqualified and its throughput burned.

> ✍️ **TODO(you):** this definition is a starting point. It needs (a) §6.3's composition rule pinned down, (b) an argument that A grows at some minimum rate with honest activity, and (c) the relation to insurance withdrawal (§8.2) — losing insurance is a trust event visible to clients before canonicality ever flips.

## 7. Aggregation

Every block except the genesis block has a single aggregation output, addressed to a well-known aggregation contract. The aggregation contract takes no parameters; this means any aggregator can claim any aggregation output. The amount represents a fee paid to the aggregator, mostly to cover the insurance they will post.

An aggregation block is simply a block that claims at least 2 similarly-sized aggregation outputs. This organizes the set of blocks into a forest; a set of trees. As new blocks get created, they get aggregated into a small tree, which will eventually get aggregated into a larger tree, etc. Each claimed block's size must be less than N% of the aggregate size, N% = 60% — this is the balance rule behind every O(log N) bound in the paper (and see the size-terminology flag in §4.2).

Aggregations serve 4 functions:

1. Ordering the tree of blocks
2. Aggregating weight for efficient descendant work computation
3. Insuring against double-spends in any block in their subtrees
4. Insuring against failing verifiers in any block in their subtrees

> Note: this also excludes aggregating the same block twice, as its aggregation output would be double-spent.

**Probing.** Before creating an aggregation, a peer needs to evaluate the risk/reward tradeoff. The reward is the fees paid via the aggregation outputs. The risk is the insurance they are placing, covering the blocks in their subtrees. They can reduce this risk by probing the subtrees, and if they find an issue they can claim a reward from the current insurer. Probing tries to measure 2 risks:

1. Double-spends (sampled via the frontier throughput and the claimed mask, §4.6 — but it also needs to look for double-spends against the already-insured subtrees)
2. Failing verifiers, sampled via §6.2's machinery, weighted by throughput

A failing query (ref, validity, etc) usually occurs while tree probing to evaluate insurability. A failing subset of N% of queries should be extrapolated to that percentage of blocks failing in the full subtree. Failing blocks mean you will pay insurance.

Probing should concentrate on the young frontier: only the youngest blocks of a subtree — those inside the detection horizon — still carry meaningful claim risk, while the old bulk is dead weight risk-wise (§8.3). Aggregators acting as bounty hunters against the current root concentrates detection hazard in spikes at merge times, which is a feature: it's the mechanism that front-loads the detection-delay distribution the insurance pricing depends on.

**Competition.** It's likely more than one peer may be probing and aggregating a given subtree. The one who becomes canonical and receives the reward is determined by the claim resolution logic, in the same way that any claim winner is determined: by the amount of derived work. Typically this is the first, so quick probers and publishers will be more profitable.

**The deception game.** If no one publishes invalid blocks, probing earns nothing; if probing earns nothing, aggregators stop probing; if no one probes, fraud is free. A perfectly honest network has zero verification incentive and is maximally vulnerable to the first attacker. Scaffold resolves this by _letting the attacker exist and pricing them_. A rational author can publish an invalid block, post collateral, pay the fee, and wait. If the aggregator probes and catches it (probability q), the block is rejected and the author's remaining collateral is claimed. If the aggregator misses, aggregation transfers the risk — the author's collateral is released, the aggregator's insurance now covers the block — and the author immediately proves their own block invalid, collecting the finder's reward `α·t` from the insurance that just accepted it.

Both sides mix, and the equilibrium (Appendix E) is self-correcting: the fraud rate settles at `p* ≈ v / ((1+α)·t + C)` — exactly high enough that the aggregator's probing pays for itself — and the probe rate settles at `q*` — exactly high enough that deception earns the honest payoff with higher variance, so risk-averse authors stay honest. If aggregators slack, deception turns strictly profitable and deceivers multiply until probing pays again. This is Truebit's forced-errors mechanism made endogenous: instead of the protocol injecting errors and taxing everyone for the jackpot, rational adversaries supply the errors and the jackpot is paid by exactly the aggregator who failed to probe.

Three properties are worth stating. First, equilibrium deception is _victimless by construction_: a rational deceiver invalidly claims their own outputs, because a stranger-victim would hold the fault proof too and race them for the reward — so the equilibrium taxes lazy insurers without touching users. Second, the expected fraud value per block is `p*·(1+α)·t ≈ v`: a block's expected fraud loss equals its verification cost, independent of throughput, which is what makes the risk component of the fee flat in v (below). Third, the game is the counterweight to the aggregation race: §6.4 rewards the fastest aggregator, and without deceivers, skipping the probe is pure speed advantage; with deceivers at rate p*, fast-and-lazy is precisely the strategy that gets farmed.

**The fee.** Competition drives the fee to the aggregator's marginal cost, which has two components with different scaling:

```
f  ≈  a·v  +  b·t·D
```

The first term covers probing and equilibrium fraud losses, and both are proportional to _verification cost_, not throughput: probing costs q·v, and the expected fraud loss is p*·(1+α)·t ≈ v (the equilibrium result above). The second term is capital carry: the insurer locks capital proportional to the block's throughput t for the coverage duration D, and locked capital has a price. For ordinary blocks the v-term dominates and "fee ≈ verification cost" is a good approximation; for high-throughput, cheap-to-verify blocks the capital term dominates — the correct repricing of what would otherwise be under-priced insurance.

> ❓ **Open:** the earlier one-parameter form `verification_cost · throughput / AVG(throughput)` conflates the two terms — it averages out to v per block but misprices both tails (charges high-t honest value transfer for _risk_ it doesn't add, and ignores coverage duration). Derive a and b from Appendix E and §8.3, including the reserve ratio's effect on b (partial reserves shrink locked capital ~10× at the cost of tail-ruin risk, §8.4).

Aggregation contracts specify a single output to a resolution contract.

> ❓ **Open:** the resolution contract is referenced but never defined — presumably the contest-resolution machinery of §9.8. Decide and specify.

## 8. Insurance

### 8.1 Two kinds of coverage

There are 2 kinds of insurance:

1. **Short-term serving insurance.** This is always the author's responsibility, and evaporates over a few minutes or hours. This supports inversions of hashes on the block (like refs and the anchor) and query-based validities (like non-uniqueness presentations), and pays a reward to anyone finding an issue.
2. **Long-term rectification insurance.** This responsibility is passed to aggregators, and never goes away. This supports verification failures, and pays the disqualification burn.

The deeper cut is not duration but adjudicability: serving insurance covers _interactive_ claims — data availability and query-based checks, which can't be auto-adjudicated — while rectification insurance covers _provable_ faults, which can. The durations fall out as consequences.

**Serving collateral mechanics.** The author's serving collateral decays exponentially back to the author, `C(t) = C₀ · e^(−c·(now − block_timestamp))`, and is never transferred to an aggregator. Challenges double as data queries: to descend into a subtree, post a challenge bond on a hash; whoever holds the preimage responds, earning the bond, and the challenger gets the data — verification and graph traversal are one paid operation. If no one responds, unavailability is itself the fault and the challenger claims the decaying collateral. The decay is what makes data-hiding a dominated strategy: an honest self-flagger acts within seconds of risk transfer and collects nearly full value, while a wait-and-reveal attacker's prize rots away.

> ❓ **Open (calibration, load-bearing):** two sizing rules the spec must adopt. (1) The decay half-life must exceed realistic catch latency, or deterrence collapses — at c = 0.3/s, an aggregator catching 10s after publication finds 5% of the collateral left, and the equilibrium then demands q* → 0.91 (Appendix E); size the half-life to gossip + probe latency, likely tens of seconds to minutes, not the 2–3s in the original notes. (2) The collateral must scale with the block's throughput, `C₀ = k·t` — with flat collateral, high-throughput deception has a flat downside against a prize of α·t, and q* climbs toward 1 for large blocks (§10.1).

> Note that query-based invalidities mean that generation can't be automatic. Implement this as separate blocks that lock funds and selectively release them (§9.8).

It's expected that a large fraction of blocks will be forgotten pretty quickly. This is why long-term insurance isn't responsible for data serving — with one necessary exception: **evidence custody**. A rectification claim requires the faulting block's data, and after the serving window the current insurer (who fetched the data to probe before insuring) may be its only custodian — with every incentive to withhold the evidence against themselves. Rectification insurance must therefore also pay on _unanswered availability challenges against insured claims_: the insurer either serves the data on demand, letting the challenger check validity, or the silence itself becomes the provable fault. Without this rule, computational faults become unprovable exactly when victims discover them (§10.3).

### 8.2 Structural coverage via the aggregation chain

The successive aggregations of a block are called the aggregation chain. Multiple aggregation chains may exist, for example when an aggregation output is claimed multiple times, but only one will be canonical. This chain is important for two reasons:

1. It proves that the block is well-known and trusted. A large, well-known aggregation root with insurance implies trust in the block.
2. It proves absence of discovered invalidity or double-spends. Both of those are encoded into an aggregation.

> ❓ **Open (recommended):** make coverage _structural_ — require every aggregation block to carry an insurance output ≥ f(declared subtree throughput). Coverage then becomes verifiable from the aggregation chain itself ("the aggregation chain is the chain of custody for the insurance"), clients read it off the O(log N) path they already fetch, and the capitalization question of §8.4 gets a partial answer for free.

**Funding and payouts.** Insurance is parameterized by a target block hash, which is the tree root that it covers. Negative contest resolutions can be claimed, which give payouts. More funds can also be added. Once the target block gets aggregated, it requests the remaining insurance, which gets returned to the insurers, and the fee is distributed to who funded the payouts.

Payouts are drawn **sequentially (tranched)**: from the first fund to the last, first-loss capital absorbing payouts first and earning the larger fee share — this is how risk capital prices heterogeneous appetite, and it's barely more complex than the pro-rata alternative (drawn equally from the total pool, fees proportional to funding), which is recorded in Appendix B.

> ❓ **Open:** pin the tranche fee split. The notes suggest "the first (2x the payouts) from the funds is the ratio by which the fees get distributed" — formalize or replace.

The target block's aggregator (which claims the last block in the insurance chain) includes block hashes (or paths, which might be smaller) of the newly disqualified blocks.

Remaining funds can always be withdrawn, but you lose fees. This allows insurers of non-canonical branches to regain their funds. Once this happens, that non-canonical branch loses trust because it lost insurance.

### 8.3 Premium pricing via detection-delay CDFs

Established result (derivation to be imported): with p the per-block fault rate and F the detection-delay CDF, the expected claims against the insurer of a size-m aggregation are

```
C(m) ≈ p ∫₀^m [F(a+m) − F(a)] da
```

because successive insurers partition each block's post-publication timeline — total expected claims per block are conserved at p across the whole chain; aggregation levels merely redistribute _when_ detection lands. Two regimes: quadratic growth for m below the detection horizon N, saturating to the constant p·μ (μ = mean detection delay) beyond it. The plateau is Little's law: undetected faults accumulate at rate p and reside for mean time μ, so a large insurer absorbs a fixed latent stock, not a growing one. Per-block expected claims decline like pμ/m past the horizon — larger aggregations are structurally safer per unit insured.

The catch: **F is endogenous to the probing policy.** A fixed per-aggregation probe budget yields a 1/a hazard tail — divergent μ, logarithmic claim growth, no plateau, and permanently undetected faults, which breaks the validity guarantee outright. The plateau requires front-loaded probing, which the bounty-hunting merge dynamics of §7 naturally provide. And the plateau is a _mean_: an adversary can time a burst of invalid blocks so their detections land on one aggregation — worst case min(m, N) claims — so capital must be sized against adversarial quantiles, not p·μ.

The deception game splits the fault population into two classes with very different F. **Strategic** faults (§7) self-report at the instant of risk transfer — their detection delay past aggregation is essentially zero, front-loading F exactly as this section requires. **Malicious** faults — an attacker who wants the invalid state to _persist_ — do not self-report, and at equilibrium no third party is paid to hunt them at random (Appendix E); their detection is victim-driven: the owner of an invalidly claimed output notices when they next try to spend it, and challenge-as-query traversal (§8.1) sweeps active subtrees as a byproduct. Victim-check delays are plausibly heavy-tailed, so the convenient assumption `P(invalid | unchallenged for t) ≈ p·e^(−λt)` — which underwrites releasing insurance capital as blocks solidify — is unjustified for the malicious class and must be derived from victim behavior, not asserted.

> ✍️ **TODO(you):** import the C(m) derivation, then derive §7's fee constants from it — separately per fault class: the strategic class's F is a spike at the aggregation boundary (the game gives you this for free), the malicious class's F needs the victim-check-rate model above.

### 8.4 Cascades, coverage ratios, solvency

Two properties damp cascades (§5.4): invalidities don't propagate downstream — work built on a fault is left alone — and each block is disqualified at most once. What does propagate is negative canonicality: when a fault's burn exceeds its descendant work, the whole branch below it goes uncanonical, and the insurers of that branch face correlated withdrawal.

The structural solvency concern: long-term rectification liability scales with _cumulative_ insured throughput (it never expires), while fee income is a _flow_. Structural coverage with tranching (§8.2) bounds each insurer's exposure to their posted tranche; the system-level question — a coverage ratio κ = posted insurance / latent fault mass, sized at the adversarial quantiles of §8.3 — is unanalyzed.

**Partial reserves.** An insurer covering N blocks needn't post the full worst case `(1+α)·Σtᵢ`; at equilibrium fraud rates (p* ~ 0.04% in Appendix E's worked example) a ~10% reserve covers the expected fraud a hundred times over. Correlated fraud is _easier to sample-detect_, not harder — at a 33% probe rate, a batch that is 20% invalid escapes with probability ~10⁻²⁸ — but detecting one member doesn't localize the rest (deeper probing costs real v), and a _timed_ adversarial reveal can land up to min(m, N) claims on a single insurer (§8.3). The reserve ratio is therefore a risk parameter, not a game parameter — it leaves p*, q*, and f's risk term unchanged while scaling the capital term — but it cannot be left purely to the market: insurer ruin externalizes onto unrestored victims, so the protocol needs a solvency floor, which is what structural coverage plus tranching (§8.2) exists to provide.

> ✍️ **TODO(you):** cascade analysis proper: can one deep disqualification's burn exceed the local tranche, and where does the excess land; correlated-withdrawal dynamics after a branch loses canonicality; a solvency invariant clients can check from the aggregation chain.

## 9. Contracts and execution

### 9.1 Execution model

Contracts are WASM programs. Execution cost — CPU time, memory — is metered, and is exactly the block's weight evaluation (§6.1). When a contract publishes a result, it re-encodes the params canonically.

Contracts should be encouraged to read random bytes. This mixes block hashes into the data, which helps solidify the graph, and prevents double-posting work on multiple branches.

### 9.2 The contract interface

The contract interface is used both during generation and verification — every contract is a generator/verifier pair.

A contract has a pre-claim step that filters claims. It accepts an env, can request outputs in bulk or incrementally, and finishes by claiming the desired outputs. These are passed to the main generator/verifier step. Alternatives under consideration: a more specific delegate contract that emits some kind of message for the main contract; or a routing method that takes claims and routes them to appropriate contracts.

> ✍️ **TODO(you):** the original draft trails off here — pick one shape for the pre-claim interface and specify it.
> ❓ **Open (decided in principle, unspecified):** contracts that need a _complete_ claim set (tallies, votes, insurance-event collection) hit the completeness-as-negative-statement problem — a resolver can validly claim a subset. For enumerable claim sets: quorum certificates plus non-membership proofs against a committed sorted structure (check whether global output indices already provide the canonical key ordering for free). For non-enumerable sets: optimistic resolution with (commitment, bond, challenge window, challenge types), the window length coming from §8.3's quantile analysis; a QC is the zero-length-window degenerate case, so one interface covers both. Avoid fold/accumulator chains — they serialize contributors (the EUTXO contention failure). Canonicality boosts help liveness here but are not a safety mechanism (Appendix B).

### 9.3 Capabilities

A query can also contain a set of capabilities along with the params and data:

- Signature capability (specific private key -> void)
- Requestor contract hash

> ❓ **Open:** tentative — needs a use-case-driven pass.

### 9.4 Claim routing and ordering

You should be able to claim from a number of verifiers, and you get the one that arrives first (so claims are ordered). This also generalizes to claiming from a timestamp pseudo-output.

> ❓ **Open:** tentative sketch; "fetch all?" from the notes is unresolved.

### 9.5 ALLOWED_PRODUCERS

If the contract contains an `ALLOWED_PRODUCERS` property, it should be interpreted as a JSON array of hashes. Only those contracts are allowed to put that output onto a block.

### 9.6 Stalling outputs

An output may be flagged `stalling`, which causes the block to be stalled. Stalled blocks are not aggregatable or anchorable UNLESS the descendant block claims all stalling outputs. This allows a block to not gain descendant weight until an output gets claimed.

### 9.7 Timestamps and time-locks

A block's timestamp must be greater than or equal to the timestamps of the anchor and all aggregated blocks. Generally, peers want to publish blocks with minimal timestamps, so blocks with timestamps in the future will not be aggregated or built upon by peers until that time comes to pass.

Let's say a block wants to lock funds until a date D. Then, its output contract can specify that the claiming block must have a timestamp of D or greater. Claims with timestamp D can be published even before D, but will not be aggregated or gain descendant work. As such their weight will remain small until time D.

**The honest-timestamp assumption, stated:** time-locks are exactly as strong as peers' refusal to build on future-dated blocks. Formally: assume clocks are synchronized within δ across the peers producing the weight-majority of aggregation; then a future-dated block accrues no meaningful weight before its declared time minus δ, and every time-lock is soft by up to δ.

### 9.8 Contract-driven insurance resolution

The insurance resolution can be specified by the contract, based upon presented data — like hints. Outputs that lock funds and release them selectively are basically the same as hints, slightly different because they don't make the original block invalid, which is useful to regenerate slow-responding aggregations.

Possible contest resolution flow to discover who's currently insuring the block:

```
setTargetTimestamp(vote_resolution_timestamp)
claimer(params.block_hash, aggregation_contract_hash, '') -> aggregation_block_hash_1
claimer(aggregation_block_hash_1, aggregation_contract_hash, '') -> aggregation_block_hash_2
...
claimer(aggregation_block_hash_N, aggregation_contract_hash, '') -> undefined
send(my_claimer_of, {aggregation_block_hash_N, aggregation_contract_hash, ''}, vote_direction)
```

> ✍️ **TODO(you):** rough sketch — align with the resolution-contract interface once §9.2's open item is decided.

## 10. Security analysis

> ✍️ This section is new; each subsection names the attack, the current defense, and what's unproven.

### 10.1 The deception game's residual attacks

Publish an invalid block, get it insured by someone who didn't probe, self-report, collect α·t. An earlier draft treated this as a fatal attack; §7 prices it as the mechanism that funds verification. It is not fatal — but it is _conditionally_ safe. The equilibrium stands on four legs, and each missing leg is a residual attack:

1. **Self-collusion (closed).** Aggregating and self-reporting your own block pays the reward out of your own insurance and forfeits the burn: net ≤ −t. The burn — never recycled to any player — is what forces the game to have a genuine victim-insurer; it must never be waived or redirected.
2. **Unbounded-throughput deception (open in the spec).** The deceiver's prize α·t scales with throughput, which is free to manufacture, so the downside must scale too: author collateral `C₀ = k·t` (§8.1). With flat collateral the equilibrium probe rate climbs toward 1 for large blocks (q* = 0.33 at t = 10³ but 0.98 at t = 10⁵, Appendix E) and the game stops being cheap; with proportional collateral, q* is throughput-independent.
3. **Bounty sniping (open, most important).** A computational fault proof is recomputable by anyone from public data — so when the deceiver publishes their claim, the insurer can race them with an identical claim and pay the reward to themselves. Sniping quietly unwinds the mechanism: as the deceiver's race-win probability s falls, q* falls roughly with it (0.33 at s = 1, 0.20 at s = 0.5, 0.05 at s = 0.1) while the fraud rate _rises_ — individually-rational front-running by insurers degrades exactly the verification the game exists to buy. Fault claims need sniping resistance: commit-reveal ordering, or a demonstrated first-mover advantage that keeps s near 1 (the self-flagger can pre-compute the claim and publish it in the same breath as the aggregation lands).
4. **Deterrent decay (open).** The collateral decay clock races the aggregator's catch latency (§8.1): if the collateral is gone before probing completes, catching pays nothing, the deceiver's downside vanishes, and q* is forced toward 1.

**Cartels are harmless:** a deceiver who tips a colluding "finder" merely reallocates the reward; the aggregator's loss, the burn, and the equilibrium are unchanged. The victim was always the aggregator who should have probed.

### 10.2 Throughput griefing

Throughput can be manufactured at no real cost, so anything that _rewards_ raw throughput is a lever — this is exactly what killed the canonicality-boost mechanisms (Appendix B). The design's response is to only ever _charge_ throughput: burns, penalties, and insurance requirements all scale with the faulting block's own throughput, so self-inflated throughput inflates your own exposure.

> ❓ **Open:** audit for remaining places where throughput confers advantage rather than liability — e.g. §6.3's "larger blocks will be prioritized" and the fee-share formulas.

### 10.3 Data withholding

Serving insurance (§8.1) makes unavailability itself claimable, and this must hold: if withheld data can't be claimed against, rectification insurance becomes untestable and the validity guarantee dies quietly (the Plasma lesson). After the serving window, forgetting is legal — clients keep the O(log N) proofs they care about (§11).

> ❓ **Open:** the exact claimable form of a serving fault is only sketched (query-based, interactive, non-automatic generation — §8.1's note); specify it.

### 10.4 Timestamp manipulation

Future-dating is policed by refusal-to-build (§9.7): the block just sits weightless until its time. Back-dating is bounded below by the anchor's and aggregates' timestamps, which the author doesn't control. Residual: an author colluding with aggregators can compress apparent time by up to the clock-sync bound δ, so every time-locked contract must tolerate δ of slack.

### 10.5 Ordering manipulation

An aggregator orders its preferred double-spend branch first, since order assigns fault (§6.4). The misordering penalty prices this: the hinge form U charges the orderer exactly the marginal harm of each inversion — a misordered pair certifies only twice the lighter child's weight (Appendix C) — and its continuity in the weights keeps peers with slightly different weight views from flipping discontinuously between penalty regimes.

> ❓ **Open:** Appendix C's gap-freezing question must be resolved, or the penalty never fades as honest descendant work accrues.

### 10.6 Cascade attacks

Bury a fault under honest work, wait for insurance to concentrate above it, then reveal for maximal correlated damage. Dampers: invalidities don't propagate (§5.4), the worst-case detection burst on one aggregation is min(m, N) (§8.3), and capital sized at adversarial quantiles absorbs it. Whether those dampers are sufficient is exactly §8.4's open analysis.

### 10.7 Hidden sub-blocks

Under-declare a subtree's weight to dodge probing while carrying a big spend: the spend can't be hidden — throughput must be exactly summed (§5.3), a mis-summed path is uninsured and the aggregator disqualified — and blocks inside uninsured paths are not eligible to claim insurance payouts. You can hide computation from probing; you can't hide value, and hidden computation earns nothing (§6.2).

### 10.8 Equilibrium

The standing inequality: `generation_cost + verification_cost <= throughput <= rectification_amount`, with rectification ≈ value(correct) − value(incorrect). The verifier's dilemma — probing must stay profitable when faults are rare, or F's tail fattens (§8.3) — is resolved by the deception game: the equilibrium fault rate p* is _definitionally_ the rate at which probing pays for itself, and it self-restores in both directions (§7, Appendix E). The corollary is sharp and should be accepted rather than fought: random third-party bounty hunting has expected value (α−1)·v < 0 at equilibrium. There is no independent-watchdog profession; every fault class must instead have a situated, paid detector (§3.4) — the aggregator before risk transfer, the self-flagger at it, the victim after it.

## 11. Client protocols

### 11.1 Node state

A node's state contains:

- A set of blocks
- A set of evaluations of the weight of a block, which is the cost of validation in units of coins (Joules). Typically this is proportional to the CPU time taken to run the WASM, but could also be based on memory usage or other resources. It's locally defined, may be noisy, but consistent weight evaluations across nodes is desired and will make consensus more efficient.
  - `weightEvaluations: { blockHash: Hash, cost: bigint }[]`

Given this state, the sampled weight of a subtree (parameterized by a block, §6.2) is a good estimator of the actual total weight of the subtree, resistant to byzantine modifications of the children's declared weights.

### 11.2 Claim resolution and proofs

Claim resolution is O(log N): `resolveClaim` (§4.5) descends the balanced forest, and the balance rule (§7) bounds the depth. An inclusion proof for a block is its aggregation path — O(log N) hashes plus the `outputCount` sums along it, which also prove the claim index arithmetic. Aggregators additionally prove claimed/unclaimed status against the merkle mask (§4.6). A client trusting a payment therefore checks: the claim resolves to the expected output, the aggregation path reaches a deeply buried root, and insurance is visible on that path (§8.2).

### 11.3 Liveness walks and subtree pruning

Chain arrays are implicitly zero beyond their end (§4.2), and knowing that a tree doesn't claim any coins from an anchor chain link lets walkers skip subsets of the tree that don't claim anything from outside a larger tree. Probers enumerating a subtree for double-spends against an old output can prune every branch whose chain entry for that output's root is zero.

> ✍️ **TODO(you):** specify the walks concretely — what a client checks to accept a payment, and what a prober enumerates when evaluating insurability.

## 12. Economics

> ✍️ This section is a skeleton; every item needs numbers once §8.3's F is pinned.

- **Issuance.** Unspecified. The natural candidates: a genesis allocation, or weight-proportional issuance (which subsidizes probing directly). Decide, then state the supply schedule in §3.2.
- **Burns.** Every disqualification burns the fault's throughput (§5.2); supply is deflationary in fault volume.
- **Fee flows.** Author attaches the aggregation fee as an output → the aggregator claims it and posts insurance → on clean aggregation, the remaining insurance returns and fees distribute by tranche seniority (§8.2); on faults, finder rewards are paid and the burn executes. The fee decomposes as `a·v + b·t·D` (§7): a verification-and-fraud-loss component priced in weight, and a capital-carry component priced in throughput × coverage duration. Burns at the equilibrium fraud rate are a permanent, priced deflation stream — the cost of verification, borne by all Joule holders.
- **Aggregator capital returns.** Return = fees / (posted capital × lockup duration) − expected losses C(m) (§8.3). The stock-vs-flow mismatch of §8.4 — liability cumulative, income flow — is the open solvency question, and the reason structural coverage plus tranching matter.

## 13. Related work and future work

**Related work.** Blockchains buy trust with full replication; Scaffold replaces replication with sampled verification and insured optimism. Optimistic rollups (Arbitrum, Optimism) are verify-by-exception, but anchor to an L1 sequencer and a fixed challenge window; Scaffold has no L1, and replaces the window with compounding detection probability plus priced residual risk. Truebit confronts the same verifier's dilemma and solves it with protocol-injected forced errors funded by a jackpot tax; Scaffold's deception game (§7) is the endogenous version — rational adversaries supply the errors, and the jackpot is paid by the insurer who failed to probe. Truebit resolves disputes with an interactive on-chain referee; Scaffold resolves them by canonicality (§6.4) — ❓ reconcile with §2's "simple voting system" claim and §9.8's vote flow: which mechanism adjudicates contested computational results? Plasma is the cautionary tale behind §10.3: unavailability must itself be claimable. UMA's optimistic oracle and Lightning watchtowers are prior art for optimistic assertion with delegated watching; Nexus Mutual and title insurance are the structural analogs for pricing latent defects. DAG ledgers (IOTA, Avalanche, Kaspa/GHOSTDAG) share the parallel structure but not the insurance layer — ordering without rectification.

> ✍️ **TODO(you):** proper citations; and decide how much of the §2 positioning to repeat vs. reference.

**Future work.** Negative output amounts (§4.1). Attached outputs — an output bound to another, possibly negative, claimable only together with it, as long as the positive one is greater. Free-market vs selfish claim classification via shared-contract differencing (sketch preserved in Appendix B). A DECIDER/AUTHORITY/JUDGE contract field, where the most canonical recursive result of `{JUDGE, block_hash}` gives the canonicality of the block. Contract-driven insurance resolution (§9.8).

## 14. Appendices

### Appendix A: v1 → v2

One of the difficulties in an arbitrary DAG is that a large spend can be buried deep inside, and there's no way for a node to "discover" it and check whether it's valid or not. You can require the aggregator sum the internal size or throughput, but they could lie. The v1 solution was that the aggregation is canonical, not the internal block. The aggregation block contains all the information necessary for UTXO transformation. Even if a buried internal block is invalid, it's ignored once aggregated.

The v2 change is that instead of requiring the aggregate to be internally consistent and encoding everything needed to transform the UTXO vector, it simply solidifies the output and insures any future invalidities found inside its subtree. Contrary to v1, double-spends don't mean the aggregation is invalid, just that coins must be burned from the insurance to ensure the total throughput is constant. Inputs must equal outputs. Misdirected funds (for example a block invalidly claiming an output) are marked invalid, allowing the output to be spent a second time, and the insurance burns some funds to make the throughput equal.

> 💡 Weight attribution also changed: v1 attributed children's weight to aggregators; v2 attributes it to anchors (§4.2). The v2 behavior is more correct.

### Appendix B: Abandoned designs

**Claim addressing alternatives** (the chosen method is option 3, §4.5). In order from simplest to most powerful:

1. A simple block hash and output index. This is simple, yet does not prove that the claimed block is included in the anchor chain. Users desire to trust a block's contents, and they do this by seeing that the block's inputs (claims and refs) are insured by well-known blocks.
2. A 3-tuple of integers: `{ chainHops, treePath, outputIndex }`. The output is resolved by following `chainHops` chain anchors, then recursively taking `block.aggregates[(treePath % block.aggregates.length) - 1]` until the path is zero, then selecting the correct output. This works but feels less elegant than option 3. It would be implemented something like this:

```typescript
// Note locateBlock(block, 0, 0) -> block (a self-claim)
function locateBlock(block: Block, chainHops: number, treePath: bigint) {
  for (let i = 0; i < chainHops; i++) {
    block = block.anchor;
  }
  while (treePath !== 0n) {
    const child = treePath % BigInt(block.children.length);
    block = block.children[child];
    treePath /= BigInt(block.children.length);
  }
}
```

3. A single integer, an index into the entire output vector defined by the block, its anchor chain, and the anchor chain's subtrees. **This is the chosen method** (§4.5).
4. A single integer, an index into the UNCLAIMED output vector. This has the advantage of being unable to address the same claim twice, eliminating the possibility of double-spends. However, the unclaimed output space changes as claims land, so resolving an index through another block requires transforming it through a claim mask (potentially very large for a large aggregation), likely requiring hash inversions for a claim mask merkle tree — a lot of machinery for clients to run to simply resolve claims. The double-spend-detection benefit was recovered without the client cost by the merkle mask of §4.6.

**Aggregations recording the descendant weight of each subtree** (maybe the descendant weight contained in the aggregation, from other following subtrees) instead of the weight vector. After aggregation, little else should anchor to the children. But it's unclear this helps; you still have to compute the subtree weight somehow.

**Canonicality boosts** — boosting conflict resolution via a canonicality boost, block throughput metric, or claim throughput metric. These boosts have no cost to create, allowing an actor to add another claim to a deeply buried output with an arbitrarily large boost, invalidating a large subset of the graph. Even throughput-based modifiers are susceptible because the account contract can simply be used to generate arbitrarily large throughputs. (Later analysis partially rehabilitated boosts as a _liveness incentive_ — an under-collecting resolution has strictly less claimed weight and loses fork choice organically — but they are insufficient as a _safety mechanism_; safety needs the challenge windows / quorum certificates of §9.2.)

**Insurance payout as a boost to the replacement** — increasing the canonicality of a replacement block, instead of decreasing the canonicality of the invalid block (as currently specified). This seems a little more complex, and the resulting aggregation fee would differ from the original block's.

**Free-market vs selfish transaction partitioning.** One interesting way to partition the claims or outputs of a block is into free-market transactions and selfish transactions. A free-market transaction is one that anyone can claim with approximately the same amount of effort, like the aggregation contract. A selfish transaction is one that requires private knowledge to claim, like the signature contract. Generally we want to select claims that have more free-market outputs, since that encourages competition. The question is how to differentiate the two; a whitelist is pretty centralized and contracts can't really be trusted to flag themselves. One interesting solution is to consider conflicting claims' outputs. The difference in amounts between SHARED contract hashes can be considered a free market bonus, while contract hashes occurring on only one block are pessimistically considered selfish. A free-market flag can be used to allow a block to say an output is NOT free-market, even if the block happens to output to it. (Not abandoned so much as unscheduled — referenced from §13.)

**Pro-rata insurance draws** — payouts drawn equally from the total fund pool, fees distributed proportionally to who funded the payouts. Superseded by tranching (§8.2).

### Appendix C: The misordering penalty and U = (T + P)/2

**Definition.** For an aggregation with children c₁…c_k in block order and w_j the descendant weight of the child at position j (correct order is heaviest-first, §4.3), the misordering demotion is the pairwise hinge penalty

```
U = Σ_{i<j} max(0, w_j − w_i)
```

— the total mass of inverted pairs, possibly multiplied by some constant factor.

**Why this form.** It is continuous in the weights, which keeps peers holding slightly different local weight views close in penalty (rank-based metrics jump discontinuously). And it has grounded semantics: for a misordered pair, the total loss of a wrong conflict resolution decomposes as min(w_a, w_b) charged to the equivocator (the unavoidable cost of the conflict existing) plus max − min — the hinge — charged to the orderer. The hinge is exactly the orderer's marginal harm. Equivalently, via the identity `w_a + w_b − max(0, w_b − w_a) = w_a + min(w_a, w_b)`, the penalized weight W − U credits a misordered pair only twice its lighter member.

**Closed form.** For any x, `max(0, x) = (|x| + x)/2`. Summing over ordered pairs i<j with x = w_j − w_i:

```
U = ½ ( Σ_{i<j} |w_j − w_i|  +  Σ_{i<j} (w_j − w_i) )  =  (T + P) / 2
```

where:

- **T = Σ\_{i<j} |w_i − w_j|** — the total pairwise spread. Order-_independent_. Each w_j appears positively in the pairs where it is the larger element and negatively where smaller; sorting ascending as w₍₁₎ ≤ … ≤ w₍ₖ₎, every pair contributes later-minus-earlier, giving the coefficient (2r − k − 1) for rank r: T = Σ_r (2r − k − 1)·w₍ᵣ₎. O(k log k), dominated by one sort.
- **P = Σ\_{i<j} (w_j − w_i)** — the signed sum over the sequence _as given_. w_j appears positively in the (j − 1) pairs where it is the later element and negatively in the (k − j) where earlier, so its coefficient is (j − 1) − (k − j) = 2j − k − 1: P = Σ_j (2j − k − 1)·w_j. O(k), one pass.

**Sanity checks.** Sorted descending (correct order): every signed pair term ≤ 0, so P = −T and U = 0. Sorted ascending (maximally wrong): P = T and U = T.

**Practical notes.** With 2–10 children (≤ 45 pairs), the naive O(k²) loop is preferable in consensus code for verifiability; the closed form matters for analysis. The pair-sum form is preferred over the per-block envelope alternative Φ = Σ_j min(w₁,…,w_j) (the LP-optimal credit) because the pair-sum applies quadratic pressure to large misordered aggregations, an explicit design goal — but the envelope is the cleaner semantic justification and worth citing in the spec.

> ❓ **Open (load-bearing):** the penalty must be computed against weight _gaps frozen at aggregation creation time_, not against recursively compounded live weights — otherwise the penalty never fades as descendant work accrues, defeating the intended fade-out. Whether post-aggregation descendant work accrues uniformly to all children (gap-freezing) decides whether weights must be snapshotted into the block. Resolve before implementation.

### Appendix D: Notation and glossary

**Core terms.** Two words are used precisely throughout, replacing the loose "size/work" of earlier drafts:

- **Weight** — cost-based: the verification cost of a block or subtree, in Joules (§6.1).
- **Throughput** — value-based: the amount of coins claimed from a given tree (§4.2).
- **Size** — ❓ still loose (§4.2's flag): used by the anchor constraint, the 60% rule, and "similarly-sized"; to be defined as one of weight / block count / output count.

**Glossary.**

- **Deeply buried:** A block that has lots of descendant weight, usually quite old. Typically canonical and would be very difficult to make uncanonical (§6.5).
- **Parent of X:** A block aggregating X (claiming X's aggregation output). Although there may be multiple parents of X, only one will eventually become canonical.
- **Child of X:** A block aggregated by X. There may be any number of children of X.
- **Leaf block:** A block with no children (claims no aggregation outputs).
- **Branch block:** A block with at least one child.
- **Tree root:** A block that currently has no parents. Typically a very large aggregation. All blocks will eventually be aggregated so this is a temporal designation.
- **Anchor chain:** The sequence of tree roots reached by following anchors from a block to genesis (§4.2).
- **Reach:** A block's own tree plus the trees of every block on its anchor chain — everything it may claim, reference, or anchor an aggregate at (§4.2).
- **Aggregation chain:** The successive aggregations of a block (§8.2). ❓ Confusable with "anchor chain" for first-time readers — consider renaming ("custody chain" fits its §8.2 role).
- **Canonicality:** A peer-local score on claims: verified weight minus penalties (§6.3).
- **Disqualified:** Marked as a fault's loser; burned, regenerable, immune to further marking (§5.4).

**Symbols.**

| Symbol   | Meaning                                     | Where         |
| -------- | ------------------------------------------- | ------------- |
| N        | detection horizon (block-units)             | §8.3          |
| m        | aggregation size                            | §8.3          |
| p        | per-block fault rate                        | §8.3          |
| μ        | mean detection delay                        | §8.3          |
| F(t)     | detection-delay CDF                         | §8.3          |
| λ        | sampling budget knob                        | §6.2          |
| π        | slot inclusion probability                  | §6.2          |
| T, P, U  | spread / signed sum / hinge penalty         | App. C        |
| κ        | coverage ratio                              | §8.4          |
| A        | finality budget                             | §6.5          |
| δ        | clock synchronization bound                 | §9.7          |
| α        | finder's share of the fault reward          | §5.5, App. E  |
| q        | equilibrium probe (verification) rate       | §7, App. E    |
| C₀, C(t) | author serving collateral, posted / decayed | §8.1          |
| c        | collateral decay constant                   | §8.1          |
| s        | self-flagger's payout race-win probability  | §10.1, App. E |
| D        | insurance coverage duration                 | §7            |

### Appendix E: The deception equilibrium

The game of §7, on v2 semantics. Per block: verification cost v, throughput t, author serving collateral worth C at catch time (posted C₀ = k·t and decaying, §8.1), aggregation fee f, finder's share α, honest publishing reward r, cost g to craft a plausible invalid block, and s the probability the self-flagger wins the payout race against snipers (§10.1).

**Payoffs.** The publisher chooses honest or deceptive; the aggregator probes each block with probability q. A catch claims the remaining collateral and forgoes the fee; a miss costs the insurer the burn plus the reward, `(1+α)·t` (§5.5).

```
publisher, honest:      r − f
publisher, deceptive:   q·(−C − g)  +  (1−q)·(s·α·t − f − g)
aggregator, probe:      (1−p)·f + p·C − v
aggregator, don't:      f − p·(1+α)·t
```

**Equilibrium.** Each side's mixture makes the other indifferent:

```
p* = v / ((1+α)·t + C − f)                        (aggregator indifference)
q*:  q·(−C−g) + (1−q)·(s·α·t − f − g) = r − f     (publisher indifference)
```

Worked example (α = 0.5, t = C₀ = 1000, v = f = r = g = 1, s = 1, no decay): **p\* ≈ 0.04%, q\* ≈ 33%**. Properties, verified numerically:

- **Fraud value-at-risk per block is p\*·(1+α)·t ≈ v** — a block's expected fraud loss equals its verification cost, independent of throughput. This is why the fee's risk component is flat in v (§7).
- **Random third-party probing is structurally unprofitable:** E = p*·α·t − v ≈ (α−1)·v < 0 for α < 1. The equilibrium fault rate is exactly low enough that only situated detectors — aggregator, self-flagger, victim — get paid.
- **q\* is throughput-independent iff C₀ ∝ t.** With flat collateral, q* rises from 0.33 (t = 10³) to 0.98 (t = 10⁵); with proportional collateral it stays ≈ ⅓ at every scale.
- **Sniping degrades the equilibrium roughly linearly:** q* = 0.33, 0.20, 0.05 at s = 1, 0.5, 0.1, while p* rises (§10.1).
- **Decay races catch latency:** at c = 0.3/s, a catch at 10s finds C ≈ 5% of C₀ and forces q* ≈ 0.91; at 30s, q* ≈ 1 (§8.1).
- **Self-collusion is dominated:** self-aggregating and self-flagging washes the fee and reward but forfeits the burn — net ≤ −t.

At equilibrium, deception earns exactly the honest payoff with higher variance, so risk-averse publishers stay honest and the realized fraud rate sits at or below p*. Off equilibrium the system self-corrects: under-probing makes deception strictly profitable, attracting deceivers until probing pays; over-probing starves them until it doesn't.

> ✍️ **TODO(you):** two corrections to the original deception notes are folded in above and should be double-checked: (1) the catch branch credits the aggregator the collateral C, and the deceptive branch pays the fee f — the original omitted both (second-order; shifts constants, not structure); (2) the one-parameter fee `v·t/t_avg` is replaced by §7's two-component form. Still open: risk-aversion's effect on realized p; the multi-level game (each re-aggregation is a fresh round at lower residual risk — does the level-k aggregator's probing incentive survive the exponentially-smaller residual?); and endogenizing s from gossip latency.
