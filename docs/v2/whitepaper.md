# Scaffold v2

<!-- claude: Title/tagline TBD. Sections follow the agreed outline; your original text is carried over verbatim wherever possible. Passages I drafted are marked with comments like this one. -->

## 1. Abstract

<!-- claude: Drafted by me -- tighten to taste. -->
Scaffold is a peer-to-peer protocol enabling trusted distributed computation. Participants publish blocks -- units of computation that claim and produce valued outputs -- into a forest of aggregation trees rather than a single chain. Blocks are accepted optimistically: rather than every participant verifying every block, aggregators roll blocks into progressively larger insured trees, and correctness is enforced by exception -- faults discovered later are compensated from insurance, with burns keeping the total supply consistent. Consensus weight is measured verification cost, estimated by unbiased sampling rather than trusted declaration. The result is a protocol light enough for browsers: fast common-case reads, O(log N) proofs, and quantitative, insurance-backed trust in any block's contents.

## 2. Introduction

Scaffold is a protocol enabling trusted distributed computation. V2 attempts to be a simplification and refinement of the conglomeration of v1 ideas.

<!-- claude: The next three paragraphs are drafted by me (the optimistic thesis, the forest rationale, and related-work positioning per your outline). Review and cut freely. -->

The core thesis is optimistic: work is accepted first and verified by exception. Traditional blockchains make every participant re-execute every state transition before accepting it. Scaffold instead accepts blocks structurally on sight, and enforces correctness through sampled probing, paid challenges, and insurance. A fault discovered after acceptance does not unwind the graph; it triggers a compensating payout and burn. Trust in a block is therefore not a binary replication guarantee but a quantity: the remaining insurance backing it relative to the value it moves.

This is also why Scaffold is a forest rather than a chain. A total order over all transactions is only needed where claims actually conflict, and most computation does not conflict. Blocks aggregate into trees, trees into larger trees, and the sequence of tree roots forms the anchor chain -- the spine on which ordering is established lazily, after the fact, at the granularity where it matters. Unrelated work never waits in line.

Scaffold relates to existing systems as follows. Like optimistic rollups, it assumes work is valid and prices the exception path -- but there is no L1 to fall back to and no fixed challenge window; the window is continuous and priced by insurance. Like Truebit-style verification games, it uses sampled re-execution to check work -- but sampling here also produces the consensus weight itself, not just dispute resolution. Like DAG protocols (Tangle, Avalanche), it admits parallel un-ordered work -- but conflicts are settled by measured verification cost, not voting. A detailed comparison with Scaffold v1 is in Appendix A.

## 3. Model and assumptions

<!-- claude: This section is drafted by me, assembled from roles and assumptions scattered through your text and the v1 docs. The Joule name comes from your outline. Review carefully -- especially the "trusted" definition, which formalizes your confidence metric. -->

**Participants.** Four roles, freely mixed by any peer:

- **Authors** create blocks: they run contracts, claim outputs, produce outputs, and pay an aggregation fee.
- **Aggregators** roll blocks into trees, post insurance covering their subtrees, and earn the fees.
- **Probers** (provers/verifiers) sample the forest, re-execute work, and earn rewards for discovering faults.
- **Clients** read state: they resolve claims, fetch results, and decide how much value to trust against how much insurance.

**Network model.** Peers are browser-capable: deterministic WASM execution, WebRTC/WebSocket transport, gossip-based block distribution. No privileged servers; server-class peers may exist for performance but have no extra protocol capabilities. The network is partially synchronous -- messages arrive eventually, and incentives (not the protocol) encourage speed.

**Adversary model.** Any participant may deviate arbitrarily. Security claims are economic, not honest-majority: the protocol aims to make every profitable deviation either detectable-and-compensated (insurance) or self-defeating (burns, forfeited fees). Collusion is considered in §10.

**The Joule.** The native token. All amounts -- fees, insurance, burns, penalties -- are denominated in Joules, and so is weight: a weight evaluation is the cost of validation in units of coins. Supply is fixed at genesis and strictly deflationary thereafter (§12).

**What "trusted" means.** A block is never trusted absolutely. A client trusts a block's contents to degree `confidence = remaining_insurance / throughput`: if the block is later proven faulty, affected parties are compensated from that insurance. "Trusted" formally means the client's value-at-risk is covered by the remaining insurance of the block's aggregation chain.

## 4. Data structures

### 4.1 Blocks

The atomic unit in scaffold is a block. A block is an immutable byte array, typically represented by its hash. A block has a number of properties, but 2 of them serve to structure a set of blocks into a forest of trees: the anchor and the aggregate array.

```typescript
interface Block {
  anchor: Hash;
  chain: { weight: bigint, throughput: bigint }[];
  aggregates: { block: Hash, outputCount: bigint }[];
  claims: bigint[];
  outputs: { contractHash: Hash, params: bytearray, data?: bytearray, amount: bigint }[];
  // Refs?
  timestampMs: number;
}
```

<!-- claude: I removed the "// Declared weight?" line since §6 resolves weight as measured-not-declared (the chain array carries the declared scaffold). "Refs?" remains open -- results/fetch need a decision, see §9. -->

An output describes funds that are only able to be retrieved by a block satisfying the given contract and parameters. Amount must be non-negative (although relaxing this restriction has some interesting mechanics we could investigate in the future). Conservation rules for amounts are in §5.

### 4.2 Anchors and the anchor chain

Each block has exactly one anchor, excluding the genesis block. The anchor is a hash to another larger-weight block -- typically a relatively recent tree root that is well-known and, together with the aggregates, contains all the claimed outputs. There's a couple of constraints on a block B's anchor:

1. It must point to a larger-size tree than B itself. Following anchors recursively gives you the anchor chain, a sequence of tree roots increasing in size. The genesis block is defined to have infinite size, and is the terminal block of all anchor chains.
2. Every block claimed or referenced in B must be included in either B or a block in B's anchor chain.

<!-- claude: "size" is load-bearing here and in the 60% rule (§7) but never defined -- fee sum, throughput, output count, and weight all give different trees. Decide one objective metric and state it here. -->

**The chain array.** The chain array specifies different properties of blocks in the anchor chain. `chain[0]` refers to the anchor. `chain[1]` refers to anchor.anchor, and so on. Beyond the end of the array, any remaining anchor chain blocks implicitly receive `{weight: 0, throughput: 0}`. Knowing that a tree doesn't claim any coins from an anchor chain link is actually pretty useful, because it lets walkers skip subsets of the tree that don't claim anything from outside a larger tree (§11).

Weight refers to the amount of work descendant of that root (by anchor). Basically, for every block in the subtree, propagate its work to its anchor until it reaches the root's anchor chain. Then it's placed into the `weight` property at that position. Example:
- The anchor chain is G <- A <- B <- C
- B aggregates B0 and B1
- A <- B0 <- B1 (B0 anchors A and B1 anchors B0)
- C aggregates C0, C1, and C2
- C0 has work 5 and anchors B0
- C1 has work 12 and anchors B1
- C2 has work 50 and anchors B
- THEN C's weight chain would be `[{weight: 50}, {weight: 17}]`

The propagation paths, spelled out:
- C2 anchors B. B is a chain block at position 0, so C2's 50 lands in `chain[0]`.
- C0 anchors B0. B0 is not a chain block, so follow B0's anchor: B0 anchors A, a chain block at position 1. C0's 5 lands in `chain[1]`.
- C1 anchors B1, which anchors B0, which anchors A. Following anchors until a chain block is reached: C1's 12 also lands in `chain[1]`, giving 5 + 12 = 17.

> 💡 Note this is different than the v1 behavior, which was to attribute children's weight to aggregators instead of anchors. The v2 behavior is more correct.

Throughput refers to the amount of coins claimed from the tree represented by that root. A claim's throughput attributes to the chain link whose tree includes the producing block. Example:
- The anchor chain is G <- A <- B <- C
- A aggregates A0 and A1
- C aggregates C0 and C1
- C0 claims 5 coins from A0
- C1 claims 12 coins from B1
- THEN C's throughput chain would be `[{throughput: 12}, {throughput: 5}]`

The paths: A0 is included in A's tree (chain position 1), so the 5 lands in `chain[1]`. B1 is included in B's tree (chain position 0), so the 12 lands in `chain[0]`.

### 4.3 Aggregation and the forest

Every block is aggregated exactly once in the canonical view, which means its hash is included in exactly one other block's aggregate array (competing aggregations exist transiently; §6 resolves them). This forms a tree structure. We say a tree T "includes" another block B if either T === B or at least one (there should only be one) of T's aggregates includes B. This is a recursive definition and informally simply reports whether B is contained in the aggregation tree of T.

Care is taken to aggregate similarly-sized trees, ensuring the tree is balanced (§7). As we will see, this gives us O(log N) proofs and queries in a number of areas.

The aggregates array is used to look up claims (§4.5). The aggregation output of each of the aggregated blocks must be claimed. The outputCount is the total number of outputs created by the entire subtree, which may be claimed or unclaimed.

### 4.4 The canonical ordering

The aggregates array should be ordered in order of descendant weight, highest to lowest. Similarly to the output space, the anchor -> subtrees -> self S should give the canonical ordering of the graph represented by a block S:
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

This ordering is load-bearing: it defines the output space (§4.5) and assigns priority among double-spends (§5) -- the first spend in canonical order survives.

### 4.5 The global output space and claims

A claim signifies that the block fulfills the contract and parameters specified by the referenced output. A claim is an index, and is resolved recursively by this formula:
```typescript
function resolveClaim(block: Block, claim: bigint): { block: Block, outputIndex: number } {
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

Note that immediately claiming an output on the same block is possible. This is called a self-claim.

Resolution is well-defined only if every declared `outputCount` is consistent: `agg.outputCount == agg.block.outputs.length + SUM(agg.block.aggregates[*].outputCount)`. This is a validity rule (§5); a resolution that overflows past a subtree into its anchor is structurally invalid, never a silent fall-through. Without this rule, an inflated outputCount would alias one physical output under two different indices, defeating mask-based double-spend detection (§4.6).

Alternative claim encodings (a direct `{blockHash, outputIndex}` reference, a path 3-tuple, and unclaimed-space indices) were considered and rejected; see Appendix B.

### 4.6 The merkle claimed-mask

The chosen claim encoding indexes into a global output vector containing both claimed and unclaimed outputs, so the transformation from one block's output space into another's is a simple addition, and no mask is needed to resolve claims.

**Light-client path.** Normal clients resolve claims by index arithmetic alone (§4.5) and never touch the mask.

**Aggregator path.** Detecting double-spends was a big benefit of unclaimed-space indices. This is mostly useful for aggregation, when an aggregator wants to know that he won't have to pay out double-spend claims. We can still do this, keeping a claimed/unclaimed bitvector in a merkle tree on each block, without affecting claim lookups.

It's very simple; each block's merkle tree encodes a bitvector with a 1 set if that output index is claimed in an aggregate. The bitvector's length is `anchor.output_space_size + SUM(aggregate[*].created_outputs)`. Notably it does not include outputs or claims of the block itself.

<!-- claude: Undecided: where is the mask's merkle root committed? It appears in no Block field. An uncommitted mask can't back proofs or challenges. Candidates: a Block field, or the aggregation output's data. Also note the bitvector spans the full historical anchor-chain output space -- fine if the merkle encoding is sparse (implicit zeros), worth one sentence. -->

## 5. Validity and faults

<!-- claude: This section reorganizes your Conflicts/Aggregation/Insurance fault text into one place: rules first, then the taxonomy, then disqualification semantics. New material is marked. -->

### 5.1 Validity rules

A block is structurally valid iff:

1. **Anchoring**: its anchor satisfies the constraints of §4.2 (larger-size tree; all claims and refs included in self or the anchor chain).
2. **Conservation**: the sum of output amounts exactly equals the sum of claimed output amounts.
3. **Count consistency**: every aggregate's declared `outputCount` matches its subtree (§4.5), and the chain array's throughput entries correctly sum the subtree's claims per anchor level.
4. **Timestamp monotonicity**: `timestampMs` is greater than or equal to the timestamps of the anchor and all aggregated blocks.
5. **Execution**: for each claim, the producing output's contract accepts the block (verifier execution passes).

Burns do not violate conservation: a burn is an output addressed to an unclaimable target (`{disqualify, block_hash}`), so the block-local balance holds while the supply available for future claims shrinks.

### 5.2 Fault taxonomy

| Fault | Detected by | Backed by | Consequence |
|---|---|---|---|
| Invalid execution (rule 5 fails) | verifier re-run (probe/sample) | rectification insurance | disqualification, burn, reward |
| Double-spend (a claim after the first, in canonical order) | mask probe + proof | rectification insurance | later spends disqualified, burn, reward |
| Throughput mis-sum (rule 3) | one-hop structural check | -- | aggregator disqualified; subtree uninsured, re-aggregatable |
| outputCount mis-sum (rule 3) | one-hop structural check | -- | same as above |
| Misordering (aggregates not in descendant-weight order) | peer-local comparison | -- | soft canonicality penalty only (§6); not aggregated |
| Data withholding (ref/anchor inversion unanswered) | query | serving insurance | reward to finder; block invalid until resolved |
| Non-uniqueness (divergent results for one verifier) | presenting both | serving insurance | reward to finder |

Double-spends are checkable by proof and are given directly to the insurance payout block. Contests (invalid execution) are for things that require running the verifier.

<!-- claude: Gap: non-uniqueness is only punishable while serving insurance lasts ("a few minutes or hours", §8). After it evaporates, two divergent results for the same verifier both persist, and nothing in the conflict rules addresses result divergence -- conflicts are defined over output claims only. Decide: (a) divergent results are a conflict class (all but one canonical), or (b) long-term uniqueness rides on the canonicality of the producing branches, accepting divergence when both branches are canonical. -->

### 5.3 Disqualification semantics

An invalid block or a double-spend (just one of the multiple claims) gets marked "disqualified" in some aggregator.
- Disqualified blocks are no longer eligible to be marked in a double-spend or as invalid.
- Disqualified block's canonicality gets decremented by the throughput, which gets burned.
- Any negative canonicality is flagged and propagates to descendants, which makes the whole downstream uncanonical.
- Any disqualified block doesn't participate in double-spends, so you can regenerate the claim. The new block behaves exactly the same as it would if it had been generated originally.
- A misordered aggregation is similar, although its disqualification doesn't get aggregated like an invalidity or double-spend.

A double-spend is an invalidity of the aggregator. All spends following the first one (in the canonical traversal of the tree) are disqualified.

> Note that although negative canonicalities propagate to descendants, invalidities don't. This is because lots of work could be built on an invalid block, and in this case we leave that work alone, while freeing up the original output to be claimed again. On the other hand if the descendant work doesn't exceed the throughput, the canonicality will become negative and that WILL propagate downstream, effectively making the whole branch uncanonical.

**Hard vs soft.** Invalidity, double-spend, and mis-summing are hard faults: they disqualify, burn, and are recorded in the aggregation chain. Misordering is a soft fault: it is a local canonicality penalty, never aggregated, and carries no burn.

<!-- claude: Why the same burn for invalidity and double-spend deserves one sentence: for a double-spend the burn compensates the inflation created by freeing the output for re-spend; for plain invalidity there is no inflation and the burn is pure penalty. Confirm both are intended to burn the full block throughput. -->

## 6. Weight and consensus

<!-- claude: New section, assembled from your Conflicts and Consensus text plus the decisions from our discussion: weight = measured verification cost; fees as branch sampling weights (your choice), with my proposal on the aggregation-sampling question marked below. Review the whole section. -->

### 6.1 What weight is

Weight is verification cost, measured in Joules. A node maintains a set of evaluations of the weight of a block, which is the cost of validation in units of coins. Typically this is proportional to the CPU time taken to run the WASM, but could also be based on memory usage or other resources. It's locally defined, may be noisy, but consistent weight evaluations across nodes is desired and will make consensus more efficient.

- `weightEvaluations: { blockHash: Hash, cost: bigint }[]`

Weight is costly to fake because it is never taken on declaration: trees can declare arbitrary weight, so instead of trusting it peers sample and evaluate locally. The declared chain weights (§4.2) are scaffolding that tells samplers where to look; the effective weight a peer uses is its own sampled estimate. Fees make sustained inflation expensive (§10, §12).

### 6.2 Sampling-based weight verification

Peers descend a tree by sampling, at each branch choosing a child proportional to its aggregation fee. Once a leaf is reached, the peer verifies the block and measures the cost (cpu usage, memory, etc). This propagates back up the tree, scaling up by the inverse probability of sampling each child, until the root has an estimate. This can occur multiple times to get a more accurate measurement.

Example code:
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

This is a Horvitz-Thompson estimator: it is unbiased for the true total verification cost under *any* positive, known inclusion probabilities. The choice of branch weights therefore does not affect correctness -- it affects variance, and it decides where scrutiny concentrates.

<!-- claude: Draft answer to your open question ("does an aggregation's fee reflect its verification cost the way a leaf's does?") -- proposal, review before adopting:

It doesn't, and it doesn't need to. Split the roles:

1. An aggregation block's own verification cost is just its structural checks (sums, counts, ordering) -- cheap, and measured directly by estimateSelf() whenever the sampler visits the node. No fee proxy needed.
2. An aggregation's *fee* converges (under forwarding competition) to the residual risk of its subtree -- the not-yet-probed exposure its parent takes on. That is exactly the right number for the parent pricing insurance, and exactly the wrong number for weight descent: old, well-probed subtrees have huge historical verification cost but near-zero residual fee.
3. So use two descent metrics for the two probes you already distinguish in §7: weight audits descend proportional to declared chain weight (a subtree claiming consensus mass thereby buys proportional scrutiny -- an attacker cannot claim weight quietly); insurance probing descends proportional to fee/throughput (scrutiny follows residual risk). HT unbiasedness holds for both; each is variance-optimized for what it estimates.

If you adopt this, 6.2's "proportional to its aggregation fee" becomes "proportional to declared weight" for the weight audit, and the fee-proportional descent moves to §7 probing. -->

### 6.3 Canonicality

Locally, a peer should give each claim a canonicality of `descendant_weight + self_weight - disqualification_penalty - misordering_penalty`
- `descendant_weight + self_weight` is sampled, verified weight from descendant trees.

`disqualification_penalty = IF(disqualified, throughput * disqualification_factor, 0)`
`misordering_penalty = IF(misordered, throughput * misordering_factor, 0)`

<!-- claude: The flat misordering boolean is judged against peer-local sampled weights, so near-equal children will flip order across peers and toggle a penalty of size throughput*factor -- enough to flip canonicality signs discontinuously. Consider a tolerance band (only penalize violations beyond some ratio) or the smooth adaptive penalty from Appendix B, which was noise-robust. -->

A block is canonical iff:
1. its anchor is canonical,
2. it wins every conflict on every claim (by canonicality score; ties broken by hash), and
3. its canonicality score is non-negative.

Descendants of a conflict loser are non-canonical through rule 1, recursively. Disqualification (§5.3) is deliberately *not* non-canonicality: a disqualified block stays in the tree, weightless, its faults compensated by insurance.

<!-- claude: Rules 1-3 are my reconstruction (v1's three rules minus the aggregates rule, which v2's insurance model deliberately drops). Confirm, especially rule 2's scope: it includes aggregation-output claims, which is what makes competing aggregations mutually exclusive. -->

### 6.4 Fork choice, ordering, fault assignment

Conflict resolution proceeds in one direction: canonicality scores pick the winning claim of each conflict; the winners fix which aggregations are canonical; the canonical aggregations fix the canonical traversal (§4.4); and the traversal order assigns fault priority -- the first spend of an output in canonical order is legitimate, all later spends are disqualified. Weight is computed canonically-independently (from structure and sampling only), so there is no circularity between weight and canonicality.

### 6.5 Finality

<!-- claude: Drafted. -->
There is no absolute finality. A block becomes *deeply buried* as descendant weight accumulates: reverting it requires out-weighing everything built above it, and the cost grows monotonically. For a client, the operative definition is economic: a block is final **for a given purpose** when `min(cost_to_revert, remaining_insurance)` exceeds the value the client has at risk. Both terms are observable: cost-to-revert from sampled descendant weight, remaining insurance from the aggregation chain (§8).

## 7. Aggregation

Every block except the genesis block has a single aggregation output. An aggregation block is simply a block that claims at least 2 similarly-sized aggregation outputs. This organizes the set of blocks into a forest; a set of trees. As new blocks get created, they get aggregated into a small tree, which will eventually get aggregated into a larger tree, etc.

Each claimed block's size must be less than N% of the aggregate size. N% = 60%

Aggregations serve 4 functions:
1. Ordering the tree of blocks
2. Aggregating weight for efficient descendant work computation
3. Insuring against double-spends in any block in their subtrees
4. Insuring against failing verifiers in any block in their subtrees

> Note: This also excludes aggregating the same block twice, as its aggregation output would be double-spent.

There's a well-known aggregation contract. Each block must address exactly one output to the aggregation contract. The amount represents a fee paid to the aggregator as payment, mostly to cover the insurance they will post. It's arbitrary, but the game-theoretic optimum should be approximately equal to the verification cost (§12). An aggregation contract takes no parameters; this means the aggregation contract can claim any aggregation outputs.

The aggregation output's game-theoretic optimal amount is `verification_cost * throughput / AVG(throughput)`

**Risk and probing.** Before creating an aggregation, a peer needs to evaluate the risk/reward tradeoff. The reward is the fees paid via the aggregation outputs. The risk is the insurance they are placing, covering the blocks in their subtrees. They can reduce this risk by probing the subtrees, and if they find an issue they can claim a reward from the current insurer.

It's likely more than one peer may be probing and aggregating a given subtree. The one who becomes canonical and receives the reward is determined by the claim resolution logic, in the same way that any claim winner is determined: by the amount of derived work. Typically this is the first, so quick probers and publishers will be more profitable.

Probing tries to measure 2 risks:
1. Double-spends, sampled via the merkle claimed-mask (§4.6) and frontier queries
2. Failing verifiers, sampled via throughput

<!-- claude: Your original had "???" on both lines; I filled (1) with the mask since that's what §4.6 says it's for, and left (2) as throughput per your earlier text. If the two-metric split in §6.2's comment is adopted, (2) descends by fee/throughput as residual risk. Confirm. -->

A failing query (ref, validity, etc) usually occurs while tree probing to evaluate insurability. A failing subset of N% of queries should be extrapolated to that percentage of blocks failing in the full subtree. Failing blocks mean you will pay insurance.

Including or not including a double-spend depends on the fees. If the fees are large enough to compensate for the payout, we can include both.

## 8. Insurance

### 8.1 Structural coverage via the aggregation chain

The successive aggregations of a block are called the aggregation chain. Multiple aggregation chains may exist, for example when an aggregation output is claimed multiple times, but only one will be canonical. This chain is important, for a few reasons:
1. It proves that the block is well-known and trusted. A large, well-known aggregation root with insurance implies trust in the block.
2. It proves absence of discovered invalidity or double-spends. Both of those are encoded into an aggregation.

If an aggregator A does not correctly sum the throughputs of its aggregated blocks, we say the aggregated blocks are "uninsured". The aggregator A fails validation, is disqualified, and the aggregated blocks may be aggregated again. This simply falls out of the invalidity logic, but it should be noted that once an aggregator has been disqualified (fails validation or double-spends), the path is broken. Its children and grandchildren are no longer eligible to claim insurance. Although this should hold for all kinds of disqualifications, the most important one is if throughput is not correctly summed. This should be clearly visible from the aggregation path, and any paths without correctly summed throughput are simply invalid.
- If this does not hold, a very large sub-block could be "hidden" inside an aggregation with low declared throughput, meaning it's never probed. This large sub-block should not be eligible to claim insurance payouts.

There's 2 kinds of insurance:
1. Short-term serving insurance. This is always the author's responsibility, and evaporates over a few minutes or hours. This supports inversions of hashes on the block (like refs and the anchor), and query-based validities (like non-uniqueness presentations), and pays a reward to anyone finding an issue.
2. Long-term rectification insurance. This responsibility is passed to aggregators, and never goes away. This supports verification failures, and pays the disqualification burn.

> Note that query-based invalidities mean that generation can't be automatic. Implement this as separate blocks that lock funds and selectively release it.

It's expected that a large fraction of blocks will be forgotten pretty quickly. This is why long-term insurance isn't responsible for data serving.

### 8.2 The insurance pool

Insurance is parameterized by a target block hash, which is the tree root that it covers. Negative contest resolutions can be claimed, which give payouts. More funds can also be added. Once the target block gets aggregated, it requests the remaining insurance, which gets returned to the insurers. The fee is distributed proportionally to who funded the payouts.

The target block's aggregator (which claims the last block in the insurance chain) includes block hashes (or paths, which might be smaller) of the newly disqualified blocks.

Remaining funds can always be withdrawn, but you lose fees. This allows insurers of non-canonical branches to regain their funds. Once this happens, that non-canonical branch loses trust because it lost insurance.

<!-- claude: Misaligned incentive, needs a rule: "can always be withdrawn" lets an insurer who learns of a discovered fault race their withdrawal against the payout claim -- and weight-based conflict resolution of that race is slow and gameable by the insurer. Options: a withdrawal timelock; a priority rule (payout claims beat withdrawals on the same insurance output regardless of weight); or withdrawal only at aggregation events. -->

**Payouts** (from §5's hard faults):

Invalidity insurance payout:
- Burn `throughput` -> `{disqualify, block_hash}`, which disqualifies the block
- Pays `O(throughput)` for reward
- Note: the whole block's throughput is used, not just the claim

Double-spend insurance payout:
- Burn `throughput` -> `{disqualify, block_hash}`, which disqualifies the block
- Pays `O(throughput)` for reward
- Note: the whole block's throughput is used, not just the claim

<!-- claude: The O(throughput) reward constant must be pinned: the deception equilibrium (§10.7) is p ~ fee/reward, so the constant directly sets the fraud rate. Also: burn + reward can drain up to ~2x throughput per fault -- feeds the solvency analysis in 8.5. -->

### 8.3 Tranching

<!-- claude: Drafted by me from your sequential-draw alternative ("payouts are drawn sequentially from the first fund to the last, and the first (2x the payouts) from the funds is the ratio by which the fees get distributed"). Review; the equal-draw alternative is simpler if you'd rather not price seniority. -->

Insurance funds form ordered tranches by funding time. Payouts are drawn junior-first: the earliest tranche is the first loss. Fees are distributed by risk borne, not capital contributed -- the junior tranches earn a multiple of their pro-rata share (your 2x-the-payouts rule is one concrete schedule). This prices speed: insuring a fresh, unprobed tree is riskier and pays more, which is the same force that makes quick probers profitable in §7. As a tree ages and residual risk decays, later tranches are cheap, senior, and low-yield.

### 8.4 Premium pricing via detection-delay CDFs

<!-- claude: Drafted by me -- this formalizes "risk decays as the tree ages" and should be checked against your intuition before anything builds on it. -->

Let `F(t)` be the probability that a fault, if present, has been discovered within time `t` of the block's publication (the detection-delay CDF -- driven by probing rates, sampling traffic, and client queries). An insurer covering the interval `[t1, t2]` bears, per block, expected liability

```
premium(t1, t2) ~= p * (F(t2) - F(t1)) * payout
```

where `p` is the latent fault rate. Since probing concentrates early, `F` rises steeply then flattens: almost all premium is earned (and almost all risk borne) in the first interval -- consistent with tranching (8.3) and with returning remaining insurance once `1 - F(t)` makes the residual premium smaller than any practical fee. "Solidification" is exactly the region where `p * (1 - F(t)) * payout` is negligible.

### 8.5 Coverage ratios and solvency

<!-- claude: Drafted skeleton -- the numbers depend on the reward constant (8.2) and the equilibrium fraud rate (§10.7). -->

A pool of size `P` covering a subtree of total throughput `Θ` has coverage ratio `P / Θ`. Full coverage (`P >= Θ`, worst case: every block faulty) is unaffordable and unnecessary; the equilibrium fraud rate `p` (§10.7) makes expected drain `~ p * Θ * (burn + reward multiples)`, so a reserve covering a large multiple of the expectation suffices -- correlated fraud is *easier* to catch under proportional probing, not harder, since concentration attracts sampling. The client-facing quantity is the confidence metric (§3): `remaining_insurance / throughput` of the covering chain. The reserve ratio itself is a market choice by aggregators; underinsured trees trade at visibly lower confidence.

### 8.6 Cascades

<!-- claude: Drafted from the path-break logic in 8.1. -->

When an aggregator is disqualified, its subtree's insurance path breaks: children and grandchildren cannot claim through it and are uninsured until re-aggregated. Recovery is permissionless -- disqualified blocks don't participate in double-spends, so the children's aggregation outputs can be re-claimed by a new aggregator, restoring coverage. The cascade is bounded: triggering it requires a real fault by the aggregator (costing the full throughput burn), the outage is temporary, and re-aggregation earns fresh fees, so the recovery is itself incentivized. §10.6 analyzes deliberate cascade attacks.

## 9. Contracts and execution

### 9.1 Execution model

<!-- claude: Drafted, one paragraph -- expand or point to the v1 computation/wasm-abi docs. -->
Contracts are deterministic WASM programs identified by hash. A contract runs in two modes over the same code: generation (an author constructing a block) and verification (anyone re-checking it). An output's `{contractHash, params}` is the question; its claim is the proof that the answer satisfied the contract. Determinism is mandatory: a contract whose output depends on host state produces divergent results and is punishable as non-uniqueness (§5.2).

### 9.2 The contract interface

The contract interface is used both during generation and verification.

<!-- claude: Undecided pre-claim design, carried from your draft -- three alternatives with no winner yet: (a) a pre-claim step that filters claims: accepts an env, can request outputs in bulk or incrementally, finishes by claiming the desired outputs, which are passed to the main generator/verifier step; (b) another, more specific contract that emits some kind of message for the main contract; (c) a routing method that takes claims and routes them to appropriate contracts. Relatedly: "What if the insurance resolution is specified by the contract, based upon presented data? Like hints? I think outputs that lock funds and release it selectively are basically the same as hints -- slightly different because they don't make the original block invalid, which is useful to regenerate slow-responding aggregations." Decide and promote. -->

You should be able to claim from a number of verifiers, and you get the one that arrives first (so claims are ordered).
- This also generalizes to claiming from a timestamp pseudo-output.

<!-- claude: "First arrival" is host-dependent, so a contract observing arrival order is not a pure function of its inputs -- the same purity leak the v1 results doc handled via mode()/timestampGte. Worth stating what verification accepts (any order? the committed order?). Also open from your draft: "Fetch all?" -->

What if a query can also contain a set of capabilities along with the params and data?
- Signature capability (specific private key -> void)
- Requestor contract hash

When a contract publishes a result, it re-encodes the params canonically.

Contracts should be encouraged to read random bytes. This mixes in block hashes into the data, which helps solidify the graph, and prevents double-posting work on multiple branches.

Possible contest resolution flow to discover who's currently insuring the block:
```
setTargetTimestamp(vote_resolution_timestamp)
claimer(params.block_hash, aggregation_contract_hash, '') -> aggregation_block_hash_1
claimer(aggregation_block_hash_1, aggregation_contract_hash, '') -> aggregation_block_hash_2
...
claimer(aggregation_block_hash_N, aggregation_contract_hash, '') -> undefined
send(my_claimer_of, {aggregation_block_hash_N, aggregation_contract_hash, ''}, vote_direction)
```

### 9.3 Capabilities and producer restrictions

If the contract contains an ALLOWED_PRODUCERS property, it should be interpreted as a JSON array of hashes. Only those contracts are allowed to put that output onto a block.

<!-- claude: Two questions: (a) where does a contract's "property" physically live (contract metadata format is unspecified); (b) v1's results doc dissolved producer ACLs -- a self-claimed output must pass its own contract's validation, so "who may produce this" lives inside the contract, which is strictly more expressive. Self-claims still exist in v2. If ALLOWED_PRODUCERS is back deliberately (e.g. you want a static check without executing contracts), say why here; otherwise it can be deleted. -->

### 9.4 Stalling outputs

An output may be flagged `stalling`, which causes the block to be stalled. Stalled blocks are not aggregatable or anchorable UNLESS the descendant block claims all stalling outputs. This allows a block to not gain descendant weight until an output gets claimed.

<!-- claude: Incentive gap: a stalled block pays no fee and carries no insurance, but the network stores and relays it indefinitely, and it holds a time-unbounded option on its historical anchor (bounded in value by conflicts, but free to keep open). Consider tying permissible stall duration to serving insurance, or letting stalled blocks expire. -->

### 9.5 Timestamps and time-locks

This must be greater than or equal to the timestamps of the anchor and all aggregated blocks. Generally, peers want to publish blocks with minimal timestamps, so blocks with timestamps in the future will not be aggregated or built upon by peers until that time comes to pass.

Let's say a block wants to lock funds until a date D. Then, its output contract can specify that the claiming block must have a timestamp of D or greater. Claims with timestamp D can be published even before D, but will not be aggregated or gain descendant work. As such their weight will remain small until time D.

**The honest-timestamp assumption, stated:** timestamps are not trusted as clock readings. The only assumptions are (a) validity rule 4 (monotonicity up the tree), and (b) peers refuse to build on or aggregate a block whose timestamp exceeds their local clock plus a skew tolerance δ. Time-locks are then safe because monotonicity forces D to propagate into every containing tree's timestamp, and (b) denies those trees descendant weight until real time reaches D. <!-- claude: drafted; δ needs a value or a derivation. -->

## 10. Security analysis

<!-- claude: New section. 10.1-10.7 are drafted by me from your mechanisms, my earlier flags, and the v1 deception/attacks docs. Each subsection is short; the ones needing your decision have inline comments. -->

### 10.1 Insurance fraud

*Self-flagging*: an author publishes an invalid block, waits for aggregation, then proves their own block invalid to collect the finder's reward from the aggregator's insurance. This is not a bug -- it is the engine that funds verification (10.7); the aggregator's probing rate is the rational response. *Self-insuring*: flagging a fault in a pool you funded nets zero minus burns, so profitable insurance fraud requires a third-party insurer who underpriced probing. *Withdrawal racing*: see the open rule in §8.2 -- until fixed, this is the largest hole in this section.

### 10.2 Throughput griefing

Penalties, rewards, and probing effort all scale with throughput, and throughput can be inflated by self-churn (see the boost analysis in Appendix B). Defenses: the fee is proportional to throughput (`f = v * T / T_avg`), so inflated blocks pay proportionally; probing is proportional to declared throughput, so inflation attracts scrutiny; and mis-summed throughput disqualifies the aggregator (§8.1). <!-- claude: What's not fully closed: an attacker inflating throughput on *valid* blocks raises everyone's probing costs without committing a punishable fault. The fee covers the aggregator's cost, but verify the constants make this unprofitable at scale. -->

### 10.3 Data withholding

Serving insurance (§8.1) pays anyone who reveals a requested preimage, and the author's exposure decays over the serving window, so withhold-then-exploit strategies race a shrinking prize. Blocks are only as trusted as they are responsive: a block whose data cannot be produced is invalid until resolved, and the finder is paid from serving insurance. Long-term data availability is deliberately not insured -- forgotten blocks are the expected common case.

### 10.4 Timestamp manipulation

Future-dating is self-defeating: the block is not aggregated or built on until the time arrives (§9.5), so it accrues nothing. Past-dating is bounded below by the anchor's timestamp (monotonicity) and shortens the author's own serving-insurance window. Colluding early aggregation of a future-dated block gains no descendant weight until the honest network's clocks catch up, so time-locks degrade gracefully rather than break.

### 10.5 Ordering manipulation

The canonical traversal assigns double-spend priority (§6.4), so an aggregator could order a favored spend first. The misordering penalty (§6.3) prices this, and because it is throughput-scaled it exceeds any single reordering gain for honestly-weighted children. <!-- claude: This inherits the flat-penalty brittleness flagged in §6.3 -- with a tolerance band, an attacker can hide reorderings inside the band; quantify what the band gives away (answer: only conflicts between near-equal-weight children, which tie-break by hash anyway). -->

### 10.6 Cascade attacks

An attacker who becomes an aggregator can deliberately commit a fault to break the insurance path under them (§8.6), stripping coverage from honest subtrees. Cost: the full throughput burn of the disqualifying fault, plus forfeited fees. Damage: a temporary coverage outage until permissionless re-aggregation. Since the attacker pays a hard cost for a recoverable disruption, this is griefing with negative expected value; the deeper risk is correlated cascades (one disqualification exposing many levels), which the tranching structure (8.3) absorbs junior-first.

### 10.7 The verification equilibrium

If no one publishes invalid blocks, verifiers earn nothing, verification stops, and fraud becomes free -- a perfectly honest network is maximally fragile. Scaffold instead engineers a low, stable fraud rate: publishers deceive at rate `p`, aggregators probe at rate `q`, and at equilibrium `p ~= v / R` (verification cost over insured payout) with the aggregation fee driven to `f ~= v * T / T_avg`. Deception is exactly as profitable as honesty (with more variance), verification is exactly funded, and any drift is self-correcting: more fraud makes probing profitable, less fraud makes it pointless. <!-- claude: Ported from v1 deception.md; the full derivation with the publisher/aggregator indifference conditions should come along -- worth an appendix if you don't want it inline. -->

### 10.8 Residual: private forks

Weight is measured verification cost, so a private fork's weight is capped by verifier work that honest samplers actually re-execute at reveal -- an attacker cannot declare weight into existence. What they can do is choose contracts that are cheap for them to generate and expensive for everyone to verify. At reveal, samplers pay that verification cost while the attacker paid only generation. <!-- claude: v1 bounded this by the fee being paid to a competitive market (~2x capital advantage max); with self-aggregation inside a private fork the fee is self-paid. State the v2 answer explicitly -- candidates: (a) sampled cost only counts once verified, so the fork's weight arrives too late to win races; (b) fee-forwarding competition at reveal time; (c) accept the bound and quantify it. -->

## 11. Client protocols

### 11.1 Node state

A node's state contains:

- A set of blocks
- The weight evaluations of §6.1
- <!-- claude: presumably also: the mask roots it has verified, insurance-chain heads for blocks it trusts, and pending claims -- fill in as implementation firms up. -->

### 11.2 Claim resolution and proofs

Claim resolution (§4.5) walks anchor and aggregate links; with balanced trees (§7) every resolution and every inclusion proof is O(log N). Aggregators additionally maintain the merkle claimed-mask (§4.6) for double-spend detection; light clients never need it.

### 11.3 Liveness walks and subtree pruning

<!-- claude: Drafted from your chain-array skipping remark and the aggregation-chain trust logic. -->
The chain array (§4.2) lets a walker prune aggressively: a subtree whose chain entry for some anchor link is `{weight: 0, throughput: 0}` claims nothing from outside that link's tree and can be skipped when tracing external claims. To trust a block, a client walks its aggregation chain (§8.1) upward to a well-known root, checking at each hop that no disqualification has been recorded and how much insurance remains; `remaining_insurance / throughput` along the way is the block's confidence. The walk is O(log N) hops for a balanced forest.

## 12. Economics

<!-- claude: Drafted section; issuance per your decision (fixed at genesis), fee flows reconstructed from the forwarding-competition idea that was in your deleted Failure Modes section -- confirm that mechanism is still intended. -->

### 12.1 Issuance and supply

The total supply of Joules is fixed at genesis: the genesis block outputs the entire supply to a distribution contract that governs how coins enter circulation. Every subsequent block obeys conservation (§5.1). Supply is strictly non-increasing after genesis: disqualification burns permanently remove Joules, making the system net deflationary in proportion to discovered fraud.

### 12.2 Fee flows

An author pays one aggregation fee. The first aggregator claims it, and competition among would-be aggregators of the *next* level is won by whoever forwards more fee upward -- so each level of the tree retains only its actually-incurred cost (probing, structural verification, insurance carry) and forwards the rest. The fee decays geometrically up the chain, with each level's retention equal to its marginal cost; this is what makes the fee a real cost even though it is a transfer.

### 12.3 Why the fee equals verification cost

Aggregators compete; competition drives the fee to the aggregator's marginal cost, which is dominated by verification/probing plus expected insurance payouts; at the equilibrium of §10.7 that expected payout itself equals `v`. Hence `f ~= v * T / T_avg` -- every block pays for its own verification, proportionally to the risk (throughput) it brings.

### 12.4 Aggregator capital returns

An aggregator locks insurance capital for the coverage interval and earns the tranche-weighted fee share (§8.3). Return on capital ~= `fees_earned / (capital_locked * time)`, which the detection-delay curve (§8.4) concentrates into the earliest, riskiest interval. Solvency requires reserves against the tail (§8.5).

`incentive = generation_cost + verification_cost <= throughput <= rectification_amount`
- The rectification_amount should be approximately equal to the value of a correct solution minus the value of an incorrect solution.

<!-- claude: This inequality chain (from your draft) needs a paragraph: what each bound guarantees and what breaks when violated. As written I read it as: a task must carry enough throughput to pay for its own generation+verification, and the punishment scale must exceed the gain from a wrong answer. Confirm and expand. -->

## 13. Related work and future work

<!-- claude: Drafted stubs -- fill citations and cut what you don't want to claim kinship with. -->

**Related work.** Nakamoto consensus (verify-everything, longest-chain weight); optimistic rollups (fraud proofs and challenge windows -- Scaffold makes the window continuous and priced rather than fixed); Truebit and verification games (sampled re-execution for disputes -- here promoted to the consensus weight itself); DAG ledgers (Tangle, Avalanche -- parallelism without insurance-backed validity); insurance and bonding-curve mechanisms in DeFi (tranching, seniority).

**Future work.** Virtual blocks and negative outputs (spend-before-commit); the JUDGE/DECIDER contract field and attached outputs (Appendix B); parameter calibration (disqualification and misordering factors, reward constants, skew tolerance δ, serving-insurance decay); formal treatment of the sampling estimator's variance under adversarial fee/weight declarations; the uniqueness rule's long-term enforcement (§5.2 comment).

## Appendix A: v1 → v2 changes

One of the difficulties in an arbitrary DAG is that a large spend can be buried deep inside, and there's no way for a node to "discover" it and check whether it's valid or not. You can require the aggregator sum the internal size or throughput, but they could lie. The current solution is that the aggregation is canonical, not the internal block. The aggregation block contains all the information necessary for UTXO transformation. Even if a buried internal block is invalid, it's ignored once aggregated.

The v2 change is that instead of requiring the aggregate to be internally consistent and encoding everything needed to transform the UTXO vector, it simply solidifies the output and insures any future invalidities found inside its subtree. Contrary to v1, double-spends don't mean the aggregation is invalid, just that coins must be burned from the insurance to ensure the total throughput is constant. Inputs must equal outputs. Misdirected funds (for example a block invalidly claiming an output) are marked invalid, allowing the output to be spent a second time, and the insurance burns some funds to make the throughput equal.

Major deltas, itemized:

- **Aggregation**: internally-consistent canonical summary (v1) → bonded attestation with insurance (v2). Invalid blocks are ignored-once-aggregated in v1; included-but-disqualified and compensated in v2.
- **Claims**: indices into the *surviving* (post-claim) output space with claim-mask transformations (v1) → indices into the *global* output space, claimed and unclaimed, with pure index arithmetic (v2). The mask survives only as an aggregator-side double-spend index (§4.6).
- **Weight attribution**: children's weight attributed to aggregators (v1) → to anchors (v2).
- **Victim restoration**: explicit restoration outputs (v1) → the misclaimed output is simply respendable; the insurance burn eats the inflation (v2).
- **Collateral/insurance**: two contracts (v1) → two lifetimes of one concept: serving insurance and rectification insurance (v2).
- **Results**: first-class answer model with self-claimed `{V, data}` outputs and a uniqueness rule (v1 results.md) → not yet re-specified in v2. <!-- claude: Confirm whether dropping the results model was intentional; §5.2's non-uniqueness fault and §9.3's ALLOWED_PRODUCERS both brush against it. -->

## Appendix B: Abandoned designs

**Alternative claim encodings** (see §4.5 for the chosen one):
1. A simple block hash and output index. This is simple, yet does not prove that the claimed block is included in the anchor chain. Users desire to trust a block's contents, and they do this by seeing that the block's inputs (claims and refs) are insured by well-known blocks.
2. A 3-tuple of integers: `{ chainHops, treePath, outputIndex }`. The output is resolved by following `chainHops` chain anchors, then recursively taking `block.aggregates[(treePath % block.aggregates.length) - 1]` until the path is zero, then selecting the correct output. This works but feels less elegant than the chosen method. It would be implemented something like this:
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
4. A single integer, an index into the UNCLAIMED output vector. This has the advantage of being unable to address the same claim twice, eliminating the possibility of double-spends. However, the overhead of maintaining a claim mask (potentially very large for a large aggregation) and transforming claim indexes through these likely requires hash inversions for a claim mask merkle tree, which is a lot of machinery for clients to run to simply resolve claims.

**Aggregations recording the descendant weight of each subtree** (maybe the descendant weight contained in the aggregation, from other following subtrees) instead of the weight vector. After aggregation, little else should anchor to the children. But I don't know if this helps; you still have to compute the subtree weight somehow.

**Boosting conflict resolution** via a canonicality boost, block throughput metric, or claim throughput metric. These boosts have no cost to creating them, allowing an actor to add another claim to a deeply buried output, with an arbitrarily large boost, invalidating a large subset of the graph. Even throughput-based modifiers are susceptible because the account contract can simply be used to generate arbitrarily large throughputs.

**The insurance payout increases the canonicality of a replacement**, instead of decreasing the canonicality of the invalid block (as currently specified). This seems a little more complex, and the resulting aggregation fee will be different than the original block.

**Free-market vs selfish transaction partitioning.** One interesting way to partition the claims or outputs of a block is into free-market transactions and selfish transactions. A free-market transaction is one that anyone can claim with approximately the same amount of effort, like the aggregation contract. A selfish transaction is one that requires private knowledge to claim, like the signature contract. Generally we want to select claims that have more free-market outputs, since that encourages competition. The question is how to differentiate the two; a whitelist is pretty centralized and contracts can't really be trusted to flag themselves. One interesting solution is to consider conflicting claim's outputs. The difference in amounts between SHARED contract hashes can be considered a free market bonus, while contract hashes occurring on only one block are pessimistically considered selfish. A free-market flag can be used to allow a block to say an output is NOT free-market, even if the block happens to output to it.

**An adaptive misordering demotion**: penalty `U = Σ_{i<j} max(0, w_{c_j} − w_{c_i})` over the child order with peer-local descendant weights, possibly scaled by a constant. Computable in O(k log k) -- see Appendix C. Abandoned for the flat throughput-scaled penalty of §6.3, though it remains the noise-robust alternative if the flat penalty proves brittle.

**A JUDGE/AUTHORITY/DECIDER contract field** containing a contract hash, where the most canonical (recursive) result of `{JUDGE, block_hash}` gives the canonicality of the block.

**Attached outputs**: a way to "attach" an output to another output. It could be negative, and as long as the positive one is greater and can't be claimed without the negative one, we're good.

## Appendix C: The U = (T + P) / 2 identity

<!-- claude: Derivation written by me (verified). Supports the adaptive penalty in Appendix B. -->

For a sequence of weights `w_1 … w_k` in a given order, define the misordering magnitude

```
U = Σ_{i<j} max(0, w_j − w_i)
```

(the total amount by which later elements exceed earlier ones -- zero iff the sequence is non-increasing). For any x, `max(0, x) = (|x| + x) / 2`. Summing over pairs:

```
U = ( Σ_{i<j} |w_j − w_i|  +  Σ_{i<j} (w_j − w_i) ) / 2  =  (T + P) / 2
```

**T** = `Σ_{i<j} |w_i − w_j|` is the order-independent total pairwise spread. Sorting ascending as `w_(1) … w_(k)`, each `w_(r)` is larger in (r−1) pairs and smaller in (k−r): `T = Σ_r (2r − k − 1) · w_(r)` -- O(k log k).

**P** = `Σ_{i<j} (w_j − w_i)`: element `w_m` appears with `+` in the (m−1) pairs where it is the later element and with `−` in the (k−m) pairs where it is earlier, giving coefficient `(m−1) − (k−m) = 2m − k − 1`: `P = Σ_m (2m − k − 1) · w_m` -- O(k), one pass, order-sensitive.

Thus U is computable in O(k log k) total: sort once for T, single pass for P.

## Appendix D: Notation and terminology

<!-- claude: New. Extend as symbols accumulate. -->

| Symbol | Meaning |
|---|---|
| `T`, `Θ` | Throughput of a block / total throughput of a subtree (Joules claimed) |
| `v` | Verification cost of a block (Joules) |
| `f` | Aggregation fee; optimum `f ~= v · T / T_avg` |
| `p`, `q` | Equilibrium fraud rate / probing rate (§10.7) |
| `P` | Insurance pool size; coverage ratio `P / Θ` |
| `F(t)` | Detection-delay CDF (§8.4) |
| `N%` | Aggregation balance bound (60%, §7) |
| `δ` | Timestamp skew tolerance (§9.5) |
| `U, T, P` | Misordering statistics (Appendix C) |
| confidence | `remaining_insurance / throughput` (§3) |

**Terminology.**

Deeply buried: A block that has lots of descendant weight, usually quite old. Typically canonical and would be very difficult to make uncanonical.

Parent of X: A block aggregating X (claiming X's aggregation output). Although there may be multiple parents of X, only one will eventually become canonical.

Child of X: A block aggregated by X. There may be any number of children of X.

Leaf block: A block with no children (claims no aggregation outputs).

Branch block: A block with at least one child.

Tree root: A block that currently has no parents. Typically a very large aggregation. All blocks will eventually be aggregated so this is a temporal designation.
