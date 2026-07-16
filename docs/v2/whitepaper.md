# Introduction

Scaffold is a protocol enabling trusted distributed computation. V2 attempts to be a simplification and refinement of the swarm of v1 ideas.

## Comparison to v1

One of the difficulties in an arbitrary DAG is that a large spend can be buried deep inside, and there’s no way for a node to “discover” it and check whether it’s valid or not. You can require the aggregator sum the internal size or throughput, but they could lie. The current solution is that the aggregation is canonical, not the internal block. The aggregation block contains all the information necessary for UTXO transformation. Even if a buried internal block is invalid, it’s ignored once aggregated.

The v2 change is that instead of requiring the aggregate to be internally consistent and encoding everything needed to transform the UTXO vector, it simply solidifies the output and insures any future invalidities found inside its subtree. Contrary to v1, double-spends don’t mean the aggregation is invalid, just that coins must be burned from the insurance to ensure the total throughput is constant. Inputs must equal outputs. Misdirected funds (for example a block invalidly claiming an ouput) are marked invalid, allowing the output to be spent a second time, and the insurance burns some funds to make the throughput equal.

# Protocol behavior

## Overall structure

The atomic unit in scaffold is a block. A block is an immutable byte array, typically represented by its hash. A block has a number of properties, but 2 of them serve to structure a set of blocks into a forest of trees: the anchor and the aggregate array.

Every block is aggregated exactly once, which means its hash is included in exactly one other block's aggregate array. This forms a tree structure. We say a tree T "includes" another block B if either T === B or at least one (there should only be one) of T's aggregates includes B. This is a recursive definition and informally simply reports whether B is contained in the aggregation tree of T.

Care is taken to aggregate similarly-sized trees, ensuring the tree is balanced. As we will see, this gives us O(log N) proofs and queries in a number of areas.

Each block also has exactly one anchor, excluding the genesis block. An anchor typically points to a relatively recent tree root. There's a couple of constraints on a block B's anchor:
1. It must point to a larger-size tree than B itself. Following anchors recursively gives you the anchor chain, a sequence of tree roots increasing in size. The genesis block is defined to have infinite size, and is the terminal block of all anchor chains.
2. Every block claimed or referenced in B must be included in either B or a block in B's anchor chain.

## Blocks

```typescript
interface Block {
  anchor: Hash;
  chain: { weight: bigint, throughput: bigint }[];
  aggregates: { block: Hash, outputCount: bigint }[];
  claims: bigint[];
  boosts: { claimMask: bigint, boost: bigint }[];
  outputs: { contractHash: Hash, params: bytearray, data?: bytearray, amount: bigint }[];
  // Declared weight?
  // Refs?
  timestampMs: number;
}
```

### Anchor

The anchor is a hash referring to a block that encapsulates 

### Chain

The chain array specifies different properties of blocks in the anchor chain. `chain[0]` refers to the anchor. `chain[1]` refers to anchor.anchor, and so on. Beyond the end of the array, any remaining anchor chain blocks implicitly receive `{weight: 0, throughput: 0}`. Knowing that a tree doesn't claim any coins from an anchor chain link is actually pretty useful, because it lets walkers skip subsets of the tree that don't claim anything from outside a larger tree.

Weight refers to the amount of work descendant of that root (by anchor). Basically, for every block in the subtree, propagate its work to its anchor until it reaches the root's anchor chain. Then it's placed into the `weight` property at that position. Example:
- The anchor chain is G <- A <- B <- C
- B aggregates B0 and B1
- A <- B0 <- B1 (B0 anchors A and B1 anchors B0)
- C aggregates C0, C1, and C2
- C0 has work 5 and anchors B0
- C1 has work 12 and anchors B1
- C2 has work 50 and anchors B
- THEN C's weight chain would be `[{weight: 50}, {weight: 17}]`

> 💡 Note this is different than the v1 behavior, which was to attribute children’s weight to aggregators instead of anchors. The v2 behavior is more correct.

Throughput refers to the amount of coins claimed from the tree represented by that root. Example:
- The anchor chain is G <- A <- B <- C
- A aggregates A0 and A1
- C aggregates C0 and C1
- C0 claims 5 coins from A0
- C1 claims 12 coins from B1
- THEN C's throughput chain would be `[{throughput: 12}, {throughput: 5}]`

### Aggregates

The aggregates array is used solely to lookup claims (see the next section). The aggregation output of each of the aggregated blocks must be claimed. The outputCount is the total number of outputs created by the entire subtree, which may be claimed or unclaimed.

The aggregates array should be ordered in order of descendant weight, highest to lowest.

### Claims

A claim signifies that the block fulfills the contract and parameters specified by the referenced output. A claim is an index, and is resolved recursively by this formula:
```typescript
function resolveClaim(block: Block, claim: bigint): { block: Block, outputIndex: number } {
  const outputCount = BigInt(block.outputs.length);
  if (claim < outputCount) {
    return { block, outputIndex: Number(claim) };
  }
  claim -= outputCount;

  for (const agg of block.aggregates) {
    if (claim < agg.outputCount) {
      return resolveClaim(resolveBlock(agg.block), claim);
    }
    claim -= agg.outputCount;
  }

  return resolveClaim(resolveBlock(agg.anchor), claim);
}
```

This is equivalent to indexing into the following implicit output space defined wrt a block:
```python
def generate_output_space(block: Block):
    yield from block.outputs
    for agg in reversed(block.aggregates):
        yield from generate_output_space(agg.block)
    if not is_genesis(block):
        yield from generate_output_space(block.anchor)
def resolve_claim(block: Block, claim: int):
    return list(generate_output_space(block))[claim]
```

Note that immediately claiming an output on the same block is possible. This is called a self-claim.

Sidenote: There's a couple of different ways we can specify claims. In order from simplest to most powerful:
1. A simple block hash and output index. This is simple, yet does not prove that the claimed block is included in the anchor chain. Users desire to trust a block's contents, and they do this by seeing that the block's inputs (claims and refs) are insured by well-known blocks.
2. A 3-tuple of integers: `{ chainIndex, aggregatePath, outputIndex }`. The output is resolved by following `chainIndex` chain anchors, then recursively taking `block.aggregates[(aggregatePath % block.aggregates.length) - 1]` until the path is zero, then selecting the correct output. This works but feels less elegant than the following method.
3. A single integer, an index into the entire output vector defined by the block, its anchor chain, and the anchor chain's subtrees. This is the chosen method specified above.
4. A single integer, an index into the UNCLAIMED output vector. This has the advantage of being unable to address the same claim twice, eliminating the possibility of double-spends. However, the overhead of maintaining a claim mask (potentially very large for a large aggregation) and transforming claim indexes through these likely requires hash inversions for a claim mask merkle tree, which is a lot of machinery for clients to run to simply resolve claims.

### Outputs

An output describes funds that are only able to be retrieved by a block satisfying the given contract and parameters. Amount must be non-negative (although relaxing this restriction has some interesting mechanics we could investigate in the future).

The sum of output amounts must exactly equal the sum of claimed output amounts.

### Timestamp

This must be greater than or equal to the timestamps of the anchor and all aggregated blocks. Generally, peers want to publish blocks with minimal timestamps, so blocks with timestamps in the future will not be aggregated or built upon by peers until that time comes to pass.

Let's say a block wants to lock funds until a date D. Then, its output contract can specify that the claiming block must have a timestamp of D or greater. Claims with timestamp D can be published even before D, but will not be aggregated or gain descendant work. As such their weight will remain small until time D.

## Conflicts

A block is either 

What if the canonicality boost is stored on the block, and invalidity is just a flag.


What if misordered aggregations simply means the block is invalid, and we treat it the same way (except litigation).


Each conflict uses these things to evaluate the winner:
- descendant work by iterating the anchor chains of self and parents
- Total contract throughout (only the conflicting contract)
- misordering of claims demotion
    - For child order c₁…c_k with peer-local descendant weights w: Σ_{i<j} max(0, w_{c_j} − w_{c_i})
    - Possibly multiplied by some constant factor
    - Should this be the entire block or just the contract’s claims? Probably just the aggregation contract’s claims, since that’s the only thing that’s going to have a downstream effect.
    - Computational trick for O(N log N)
        
        Define two order-statistics of the sequence:
        
        - **T = Σ_{i<j} |w_i − w_j|** — the total pairwise spread. Order-*independent*; computable in O(k log k) by sorting once: with weights sorted ascending as w₍₁₎…w₍ₖ₎, T = Σ_r (2r − k − 1)·w₍ᵣ₎.
        - **P = Σ_j (2j − k − 1)·w_j** — a signed, position-weighted sum over the sequence *as given*. O(k), one pass.
        
        Then, since U counts the positive parts of (w_j − w_i) and T counts absolute values while P counts signed values over the same pairs:
        
        **U = (T + P) / 2**


# Local behavior

Peer's incentive is to maximize profit and minimize spent resources (cpu, memory usage, etc.).

Wrt to choosing blocks, peers are incentivized to choose blocks with larger aggregation fees.
- Should it not be just aggregation fees, but include any free-market contract?


Conflicts and invalidities are not removed from the graph.
- If the throughput is 50, and the insured amount is 200, and the block is invalid:
- 50 is burnt (the 50 output becomes available again), and 200 is output to any block claiming it.




## The contract interface

The contract interface is used both during generation and verification. For example, a contract calling 

A contract has a pre-claim step that filters claims. It accepts an env, can request outputs in bulk or incrementally, and finishes by claiming the desired outputs. These are passed to the main generator/verifier step.
OR another contract that is more specific, and emits some kind of message for the main contract.
OR some kind of routing method that takes claims and routes them to appropriate contracts.
- This could be a

What if the insurance resolution is specified by the contract, based upon presented data? Like hints? I think outputs that lock funds and release it selectively are basically the same as hints.
- Slightly different because they don't make the original block invalid, which is useful to regenerate slow-responding aggregations.

## Aggregation

Every block except the genesis block has a single aggregation output. An aggregation block is simply a block that claims at least 2 similarly-sized aggregation outputs. This organizes the set of blocks into a forest; a set of trees. As new blocks get created, they get aggregated into a small tree, which will eventually get aggregated into a larger tree, etc.

<!-- claude: "Similarly-sized" needs a definition -- sized by aggregation-output amount (fee)? This is v1's weight-ratio constraint K reappearing with a new metric (dag.md, Balancing: ratio <= K gives O(log N) depth, hence O(log N) proofs and sampling descent). Worth porting that bound and naming the constant. -->

Aggregations serve 4 functions:
1. Ordering the tree of blocks
2. Aggregating weight for efficient descendant work computation
3. Insuring against double-spends in any block in their subtrees
4. Insuring against failing verifiers in any block in their subtrees

> Note: This also excludes aggregating the same block is included twice, as it's aggregation output would be double-spent.

Before creating an aggregation, a peer needs to evaluate the risk/reward tradeoff. The reward is the fees paid via the aggregation outputs. The risk is the insurance they are placing, covering the blocks in their subtrees. They can reduce this risk by probing the subtrees, and if they find an issue they can claim a reward from the current insurer.

It's likely more than one peer may be probing and aggregating a given subtree. The one who becomes canonical and receives the reward is determined by the claim resolution logic, in the same way that any claim winner is determined: by the amount of derived work. Typically this is the first, so quick probers and publishers will be more profitable.

Probing tries to measure 2 risks:
1. Double-spends, sampled via ??? (frontier-throughput, but also needs to look for double-spends in the already insured subtrees)
2. Failing verifiers, sampled via throughput

<!-- claude: The ??? is the claim-mask-replacement question (see comment at the claims blockquote). Also: "downstream sampling by verification cost (proportional to the fee)" below is arguably the better descent metric than throughput -- it concentrates scrutiny where verification is expensive, and the fee is just as structural/deterministic as throughput (it is an output amount). Worth deciding which metric drives sampling descent; v1 used throughput (sampling.md) but for reasons the fee also satisfies. -->

Aggregation contracts specify a single output to a resolution contract.

The successive aggregations of a block are called the aggregation chain. Multiple aggregation chains may exist, for example when an aggregation output is claimed multiple times, but only one will be canonical. This chain is important, for a few reasons:
1. It proves that the block is well-known and trusted. A large, well-known aggregation root with insurance implies trust in the block.
2. It proves absence of discovered invalidity or double-spends. Both of those are encoded into an aggregation.

## Resolution

<!-- claude: Empty, and it is the load-bearing section of v2 -- insurance replacing internal consistency only works if resolution is specified. What it must answer, mostly already converged in the scratchpad and gathered here:

1. Challenge types, exhaustively. Listed under the aggregation contract: block invalidity, double-spend. Implied elsewhere: mismatched sub-insurance inputs/outputs (scratchpad says it propagates to the top of the insurance tree), unresolved ref inversions (scratchpad says those hit block collateral, not insurance -- confirm). The scratchpad already draws the key procedural line: double-spends are proof-checkable and go directly to the insurance payout block; validity contests require running the verifier and go through the contest/vote machinery.
2. The payout split when an invalidity is proven: finder's reward + throughput-balancing burn + remainder stays insured. Which fraction is which? v1's alpha ~ 0.5 finder-share discussion (deception.md, collateral-resolution.md) applies.
3. Proof formats: proof of inclusion in the insured subtree AND proof of exclusion of prior claims/invalidations, using hash-inversion fetches to avoid duplicating block data (scratchpad, reads decided). The "found invalidities" vector committed to the aggregation block (scratchpad, reads decided) is what makes the exclusion proof cheap.
4. Recursion: a challenge pays out at the current insurer and recurses through delegated insurance "until the insurance resolution gets paid" (stated under the aggregation contract -- belongs here).
5. A challenge is parameterized by its "election" (the block and the thing being challenged), with a proof and an insurance as side inputs (scratchpad, reads decided).
6. Late-found invalidity: invalidated at the *current* insurance output; effect is (1) the rightful re-spend is not treated as uncanonical, and (2) later aggregations carry no double-spend liability for it (scratchpad, reads decided).
7. Zero-insurance blocks: contests still possible ("output to the insurance contract even if the insurance amount is zero", scratchpad) -- so invalidity-marking works even where no one is on the hook.
-->

## The aggregation contract

There’s a well-known aggregation contract. Each block must address exactly one output to the aggregation contract. The amount represents a fee paid to the aggregator as payment, mostly to cover the insurance they will post. It’s arbitrary, but the game-theoretic optimum should be approximately equal to the verification cost (see below for a more thorough explanation).

An aggregation contract takes no parameters; this means the aggregation contract can claim any aggregation outputs. It takes a data field matching this schema:

```typescript
interface AggregationData {
	throughput: bigint;
	vote: 
	data: Uint8Array;
}

// Fee comes from the amount
```
- throughput
- fee
- vote
- data
- aggregated throughputs (an array of bigints)
- return

<!-- claude: Schema unfinished: `vote` is untyped, and this bullet list duplicates the interface with fields that are not in it (fee, aggregated throughputs, return). Finalize one representation. -->

It outputs to a funds management contract, which claims payout proofs. It outputs to the payout address, and the remainder to the same funds management contract.

An aggregation contract can be challenged. A challenge has an amount and is one of these types:

- Block invalidity
- Double-spend

<!-- claude: Likely incomplete -- the scratchpad implies at least two more: mismatched sub-insurance inputs/outputs, and unresolved ref inversions (collateral-backed rather than insurance-backed?). See the enumeration in the Resolution comment. Also worth stating here which types are proof-checkable (direct to insurance payout) vs verifier-run (contest/vote machinery) -- the scratchpad already draws that line. -->

A block challenge is local (can only be performed once, even if insurance is delegated). It outputs to the insurance policy that claimed the block’s insurance output. This happens recursively, until the insurance resolution gets paid.

A challenge/vote is an output.

Aggregation should also allow downstream sampling by verification cost (proportional to the fee).

### Example

```
A -> B -> C -> D -> E (amount =10)
throughput is 50
aggregated into F

```

<!-- claude: Stub. Finishing it is high-value: a worked example with concrete amounts is what forces the fee/insurance/payout arithmetic to be pinned down (v1's deception.md equilibrium example with R = T = 1000, v = 1, alpha = 0.5 is a good template). -->

## Node state

A node’s state contains:

- A set of blocks
- A set of evaluations of the weight of a block, which is the cost of validation in units of coins. Typically this is proportional to the CPU time taken to run the WASM, but could also be based on memory usage or other resources. It’s locally defined, may be noisy, but consistent weight evaluations across nodes is desired and will make consensus more efficient.
    - `weightEvaluations: { blockHash: Hash, cost: bigint }[]`

<!-- claude: This says weight = sampled verification cost; Failure mode 2 says the fee "is actually the weighing mechanism". Both read as settled and they need one reconciling paragraph -- the v2 equivalent of v1 weight.md's "How They Compose". Candidate: throughput (or the fee, see sampling-descent comment) is the structural descent metric; sampled verification cost is the effective weight; the fee is the economic floor that makes weight costly to mint. The distinction matters because of the self-aggregation question (see Failure modes comment). -->

Given this state, various functions can be defined:

- The sampled weight of a subtree, parameterized by a block:
    - This is a good estimator of the actual total weight of the subtree, resistant to byzantine modifications of the children’s declared weights.
- Derived weight

Why is the aggregation fee proportional to the verification cost? …

<!-- claude: On the dangling "Why...?": deception.md already derives this -- aggregator indifference gives p = v/(R - f) ~ v/R, and competition drives f = v * T/T_avg (a throughput-proportional tax). Port or reference rather than re-derive; the same derivation is most of the answer to the insurance-sizing question in the scratchpad. -->

Contracts should be encouraged to read random bytes. This mixes in block hashes into the data, which helps solidify the graph, and prevents double-posting work on multiple branches.

<!-- claude: Mechanism unstated -- "encouraged" how (incentive, protocol requirement, convention)? And name what "random bytes" are (recent block hashes?). Also a mild tension: this says it *prevents* double-posting work on multiple branches, while the scratchpad concludes duplicating responses across branches is fine and enables piggybacking. Probably: duplicates fine for responses, bad for weight -- worth reconciling explicitly. -->

---

## Scratchpad

<!--Stolen funds just allow a double-spend. It's just an incentive to the next insurance aggregator because they'll have to rectify a double-spend.-->
It can be claimed by any descendant, given a proof of inclusion, and proof of exclusion of prior claims. Use hash inversion fetches to not duplicate block data in the proof.
Every leaf is indexed. Every potential insurance payout is indexed. At insurance aggregation time, the payouts are sealed and sent to their destinations. The aggregator can walk hashes backwards to explore the prior payouts.

Technically we can just commit the "found invalidities" vector to the aggregation block itself. Even for very large aggregations, most of the invalidities will have already been discovered so there won't be too many left.
<!-- claude: Reads decided -- promotable. This is also what makes the Resolution exclusion proofs cheap ("prove it hasn't already been invalidated" becomes a lookup in the committed vector plus the recent uncommitted tail). -->

An invalid block can be found late. It should be invalidated at the current insurance output. This invalidity means a future spend (1) won't be considered uncanonical, and (2) won't cause aggregations double-spend liabilities.

The proof of block inclusion in insurance should also prove it hasn't already been invalidated.

A challenge is parameterized by the "election", which is the block and thing being challenged. It gets as side-input a proof and an insurance.

If a sub-insurance is found to have mismatching inputs and outputs, it needs to be propagated up to the top of the insurance tree.

What are the rules of canonicality?
<!-- claude: v1's answer is a solid base: three rules -- anchor canonical, all aggregates canonical, wins all direct conflicts -- computed in one topological sweep, with weight kept canonical-independent to avoid circularity (consensus.md). The v2 delta to specify: misordering demotion, invalid-included-but-weightless vs uncanonical-excluded-but-insured, and result-uniqueness conflicts. Writing the v2 rules as a delta from v1 would keep this short. -->

- Multiple blocks can claim the same output.

The canonicality of a block should depend on the ordering of its claims. The optimal order of claims must be in order of decreasing total weight of descendants. The depth-first iteration of a tree is the canonical ordering of all sub-blocks, ending with the tree root itself.

Assume there's a block not included in the tree that should have been included. We assume it will be included on the next aggregation, and must decanonicalize the first tree.

Every block must anchor to a larger-weight block whose anchor chain includes all claims, recursively.

The descendant weight computation options:

- Coin-weighted weight (propagate weight proportional to input coins)
- Mergeable sketches - NO, probablistic
- Anchor chain with weight vector - this is nice
- Implicit anchor chain (maybe based on the last claim)

Descendant weight also has to depend on the claims and fetches.
<!-- claude: This reverses a deliberate v1 decision -- weight propagation excluded claim edges specifically to prevent double-counting ("flows toward anchors and aggregated children, not toward claims", weight-design.md Choice 7). If v2 propagates weight along claims/fetches, record why the double-count concern no longer applies or how it is bounded. -->


Should weight depend on non free market outputs or the verification fees? The verification fees. This incentivizes smaller account output. 

Given some block A:

- When another block anchors to A, it's not derived work
- When another block anchors to A and is insured

Aggregators don't want to include duplicates, because they'll have to burn coins to compensate for them.

If they aren't, locally, one needs to be ignored. If it's built upon, likely it will become uncanonical.
Both can be built upon; you can even incentivize both with the same output. But:

- Use the invalidity possibility somehow. Maybe incentivize multiple invalidities that all have to be found?
- The descendant weight isn't really the cost of generation, it's the cost of verification. So have an external pool of funds, which you can request spent on the branch. It gets spent whether or not the branch is canonical.
- OR most simply, just use the aggregation fee as the work.

Actually you can duplicate responses on all branches without issues, as long as there’s a bottleneck forcing one branch to be chosen. I think this will happen during aggregation. Also this makes possible piggybacking.
<!-- claude: Reads decided -- promotable; this is what licenses piggybacking. But see the random-bytes paragraph in the top half, which wants to *prevent* double-posting work on branches -- reconcile the two (duplicates fine for responses, bad for weight?). -->


Output to a contract that can only be claimed by a descendant of B. This is incentive that B will be canonical.
OR
Output to a burn contract,

Negative outputs?

A block is insured IF its insurance chain's throughputs match the parent's declared throughput. If it does not, the incorrectly insuring block is marked invalid, eligible for another to take its place. It is effectively un-aggregated, and that section of the subtree in the original aggregation is unable to generate proofs through the incorrectly insuring block.

Does aggregation throughout need to be insured? Yes because it’s a claim from somewhere else.

Blocks are insured by outputting to a contract that claims the aggregation fee and can be claimed in part to respond to queries and payouts. 

Aggregation outputs get collected into a single block. This block can be recreated to add more insurance inputs. Inputs can be addressed to the insurer of a specific sub tree root hash. This is committing insurance, if the tree root doesn’t become canonical it’s lost. More useful is probably just publishing a new insurance pool chain link that adds funds addressed by public key. Or you commit the aggregation fee instead of the insurance. That seems nicest because it is a sunk cost, promoting canonicality. Or you commit to insuring a block, and the insurance happens whether or not the block is canonical. You can always get the insurance back (whatever remains), but you only get the fee if the root is canonical. This incentivizes you to only aggregate canonical blocks. The aggregator also claims contests from the sub trees and resolves and releases collateral.
<!-- claude: This paragraph converges by the end: commit to insuring a block regardless of canonicality; insurance remainder always recoverable; fee only if the root becomes canonical. Reads decided -- promotable. It is also the best candidate answer to the self-aggregation problem (see Failure modes comment), but note the hole: a private-fork attacker reveals only when they expect to *win* canonicality, at which point their self-paid fee comes home. Sunk-ness has to hold on the winning path to bite. -->

Contests are separate contracts. A contest vote is an output that gets claimed by the resolution block. If it’s a negative resolution, it can claim the instance output and emit a diminished amount.

When the insurer is aggregated, it fetches or claims the contest resolutions to track which contests have been paid already.

Maybe even more insurance can be added to these resolutions. If the insurance runs out, no more can be claimed. This should behave the same as no insurance. 

Nodes use insurance to trust blocks. The amount of remaining insurance divided by the block in question’s throughput is a good measure of confidence.
<!-- claude: Reads decided -- promotable. This is a crisp v2 answer to "how much should I trust an un-finalized block", which v1 never answered directly (trust.md gestures at it via collateral). It is also the natural TrustGate input for v2. -->


But a block pays an aggregation fee to fully insure the block. It should get that. I’m not sure how to determine the required amount.
<!-- claude: This is THE open economic question of v2. Under burn-to-balance, insurer burn ~ attacker gain, so worst-case exposure scales with the *stealable throughput* of the subtree, not with fees. What makes partial coverage safe is the equilibrium: deception.md's p = v/R plus its partial-coverage argument (a 10% reserve covers ~100x expected fraud; correlated fraud is *easier* to catch under proportional sampling, not harder) transfers to v2 almost unchanged -- the payout plumbing differs, the game does not. Candidate resolution: size insurance as a reserve ratio against subtree throughput, market-chosen, with the confidence metric above exposing the ratio to users. -->


In the future we could do virtual blocks. Blocks with negative outputs make positive outputs immediately available. Aggregating a block with negative outputs only passes validation if we can absolutely generate a block that resolves the funds. This is the virtual block, and it can be used to partially spend outputs then commit them later.

Contests are just for things that require running the verifier. Double spends are checkable by proof and are given directly to the insurance payout block. 

Even if no one has insured a block, you can still contest to mark it as invalid. Maybe this is an output to the insurance contract even in the insurance amount is zero. 

There’s little need for graph rewriting in v2. The anchor should be a descendant of all the inputs for weight attribution, but technically it doesn’t have to be. 

All claims or refs in a tree should reference either a block in the tree or a block in a tree in the anchor chain. 

A contract can emit a canonicality boost, but it’s only applied to conflicts involving the contract’s claims. This is so you can’t influence canonicality by creating a custom contract. Or maybe it should be automatic, per-contract, based on the claimed throughput. When deciding the canonical set or which blocks to include in an aggregation, this rule combined with the prior one should be enough to eliminate the descendants. 

Max (current aggregation fee output, sum (child maximums))

Or just the sum of everything. 

Each conflict uses these things to evaluate the winner:

- descendant work by iterating the anchor chains of self and parents
- Total contract throughout (only the conflicting contract)
- misordering of claims demotion
    - For child order c₁…c_k with peer-local descendant weights w: Σ_{i<j} max(0, w_{c_j} − w_{c_i})
    - Possibly multiplied by some constant factor
    - Should this be the entire block or just the contract’s claims? Probably just the aggregation contract’s claims, since that’s the only thing that’s going to have a downstream effect.
    - Computational trick for O(N log N)
        
        Define two order-statistics of the sequence:
        
        - **T = Σ_{i<j} |w_i − w_j|** — the total pairwise spread. Order-*independent*; computable in O(k log k) by sorting once: with weights sorted ascending as w₍₁₎…w₍ₖ₎, T = Σ_r (2r − k − 1)·w₍ᵣ₎.
        - **P = Σ_j (2j − k − 1)·w_j** — a signed, position-weighted sum over the sequence *as given*. O(k), one pass.
        
        Then, since U counts the positive parts of (w_j − w_i) and T counts absolute values while P counts signed values over the same pairs:
        
        **U = (T + P) / 2**
        
<!-- claude: Verified: U = (T + P) / 2 is correct (checked the pair decomposition and the k=2 case). The criteria list above (descendant work, per-contract throughput, misordering demotion, invalidities-included) reads close to promotable; open sub-questions are the constant factor and the scope, where your lean (aggregation contract's claims only) seems right since those are what have downstream effects. Missing from the list: result-uniqueness conflicts (see Blocks comment). -->
- What about invalidities?
    - Invalidities that have already claimed insurance should probably not be selected against because we want to penalize the aggregators of invalid blocks.
    - I think we include invalidities like normal.

If A=20 and B=10 conflict, and B=10 and C=5 conflict, then:
- B is uncanonical because it fails in conflict with A
- C is uncanonical because it fails in conflict with B

Even uncanonical blocks should be insured or collateralized, but not included in the tree.
Invalid blocks should be included in the tree. However they should not contribute weight. This happens because the aggregation fee likely prices it out.
<!-- claude: Reads decided -- promotable, as part of the canonicality rules. Note it inverts v1 ("invalid internal blocks are ignored once aggregated"), so state it as a deliberate reversal: invalid = in the tree, weightless, insurance-compensated; uncanonical = out of the tree, still insured/collateralized. -->



What about a contract calling out to another contract that can filter claims, for example, but doesn't influence the generator state except for the returned data. It passes data by adding claims or outputs.


Descendant work is the work that will be lost if a block is not canonical.
What if we can include all or most of the descendant work in the aggregation? Why wouldn't we be able to? Because it might be trees not checked yet.
What if, instead of claiming those trees, we just reference them. We're responsible for serving them, and the ordering we place claims in must match the descendant work we uncover.


What does the aggregation define? Is it the canonical composition of blocks?
- Yes. An aggregation with invalid throughput means the sub-block is ignored; any claimed outputs are still available.
- Any outputs underneath an aggregation with invalid throughput are ignored.


Who is on the hook for pending ref inversions?
- Anyone can respond to them (they're just hash inversions), but you can claim it against a block, who will be invalid until it's resolved. It must be immediately clear that the block is responsible for it. An aggregation can't serve the entire tree.
- This invalidity isn't covered by insurance. Just the block collateral.
- What's the difference?
<!-- claude: The v1 distinction (collateral-resolution.md): collateral = the author's, short-lived, decays, deters data-hiding; insurance = the aggregator's, persistent, funds rectification. "Block responsible until resolved, backed by block collateral not insurance" is consistent with that split -- ref inversions are a data-availability duty (author-scoped), not a validity duty (aggregator-scoped). Probably the answer. -->


I think aggregation query responses can be optional. if you don’t respond, the aggregation won’t be used.
- How to do this?

What does a ref fetch look like?
- Output 5 to `{contest, block_hash, ref_hash, 5, null}`
- Respnse 5 to `{contest, block_hash, ref_hash, 5, [block_5, block_6, block_7, ...]}`
- Contest immediately resolves 10 to the output.
- Contests are completely separate, unrelated to insurance.
- A failing contest, with the path indices as proof, might be placed against the insurer for root R. The insurance contract follows the path, checks it hasn't been claimed yet, and if valid, outputs rectification and reward. It also sets its canonicality bonus based on the contest resolution bonus, so more votes will cause a re-insuring.
- Part of the first insurance coverage is the collateral, which isn't released in the first aggregation. It's kept.
- The current pending "release" of insurance funds tells whether the block is valid or not.
- The validity is like a capability or token that's passed around.
- A failing ref query usually occurs while tree probing to evaluate insurability. A failing subset of N% of queries should be extrapolated to that percentage of blocks failing in the full subtree. Failing blocks mean you will pay insurance.


How do you make sure that ALL votes are included? Desired behavior:
- Resolutions are published, which collect votes, but they aren't aggregated. They simply inform peers as to the vote set.
- One second past the last vote, the resolution gets aggregated.
- The resolution timestamp is in the future. Descendants will be forced to have a timestamp in the future, but generally blocks want a low timestamp, so no one will build on it yet.
- Any conflict with higher canonicality causes the first resolution to be ignored, even if its timestamp is in the past and the conflict is in the future.

Another solution might be that a resolution becomes invalid IF a higher-throughput resolution is presented
- This requires some extra machinery; aggregators need to know about the probability of that happening.

What if there is no invalidity? There is just a canonicality metric. Less than zero means invalid.
- What if the contract has a DECIDER or AUTHORITY or JUDGE field that contains a contract hash. The most canonical (recursive) result of `{JUDGE, block_hash}` gives the canonicality of the block.

Who sets?
- Required insurance coverage of a subtree
- 

You should be able to claim from a number of verifiers, and you get the one that arrives first (so claims are ordered).
- This also generalizes to claiming from a timestamp pseudo-output.

What's the definite way of determining whether a block is active or not, wrt to a tree root?
Do I need respect to a tree root? YES. It tells you the block is well-known.

What does sending the aggregation chain give?
- It tells you whether insurance has been claimed against the block (not necessarily if a contest has been won but not yet claimed). This includes invalidities and double-claims.
- Most importantly, it tells you the block is well-known.

How can we join these concepts:
- Collateral
- Contests and hints
- Insurance
- A chain of insurance claims
- Fetch all?

Common idea:
- A set of votes, or inputs, that is composed into a single block with outputs.

What if a query can also contain a set of capabilities along with the params and data?
- Signature capability (specific private key -> void)
- Requestor contract hash

Given the `anchor -> anchor chain -> aggregation chain -> claimed block` sequence:
- The coverage is clearly visible. This is whether or not every aggregator fully insures the block beneath it.
- The validity of the block is not clearly visible, but any validity flags are.
- The double-spendedness of the block is not clearly visible, but any double-spend flags are. Note this is simply the validity of an aggregator.

Thus, claiming a block without full insurance coverage is invalid.

What about double-spends IF we do the claim mask?
Contests or hints can only claim part of the collateral/insurance?

What about result uniqueness?
- When a contract publishes a result, it re-encodes the params canonically.
- Maybe the publication of a duplicate isn't invalid, but the claim of a non-first is.
- What about unique seals? What if contracts ran both on the claim AND output? This seems most generalizable.
- A contract can fail upon presentation of a prior block with the same params but different result.

Negative outputs:
- Anyone can claim; the contract runs on the producer??? I don't think that's a good idea because it's a pretty non-linear effect.
- Remember the larger aggregation fee is always chosen; with negative outputs, it's the largest aggregation fee + (new?) negative output sum. So you have to compensate the negative outputs with a larger fee.
- Claiming negative outputs does the opposite - releasing funds back from the aggregation fee to be output elsewhere.
- I'm not sure this is worth the complexity.
- Actually what if sending a negative output is like a signal to that contract, and must be immediately offset in the same block?

What if contracts ran both on the claim AND output?
- This allows claim chains.

Alternately: restrictions on who can create certain outputs
- Maybe just an ALLOWED_PRODUCERS array on the contract.

Alternately: The contract checks properties of the outputting block

fetch() - returns claimed, valid results
claim() - returns unclaimed datas, which may be accepted or rejected

fetch(inversion, block_hash) -> block # walks the block chain
fetch(contract_that_accepts_blocks_with_throughput_around_range, range) -> block

Or maybe a sub-call of another verifier (which could claim a message sent to it)


An anchor chain defines a global output vector, not just the unspent ones?
- No need for merkle claim masks on the lookup path, although they might be useful for merging
- The claim mask is defined per-block in the anchor's output space.

Hints:
- Not covered by insurance
- Means generation can't be automatic
- Optional result uniqueness violation
- Just implement this as separate blocks that lock funds and selectively release it.
- Double-spend reports are kind of like hints onto the insurance block's release fund.

Each claim is addressed as a chainHops + treePath tuple:
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

Block insurance output:
```
claims = claimAll()
coverage = Sum required insurance amount
output coverage to the next aggregation contract
```

Block vote output:
```
setTargetTimestamp(vote_resolution_timestamp)
claimer(params.block_hash, aggregation_contract_hash, '') -> aggregation_block_hash_1
claimer(aggregation_block_hash_1, aggregation_contract_hash, '') -> aggregation_block_hash_2
...
claimer(aggregation_block_hash_N, aggregation_contract_hash, '') -> undefined
send(my_claimer_of, {aggregation_block_hash_N, aggregation_contract_hash, ''}, vote_direction)
```

Insurance resolution:
```
claimAll(my_claimer_of, {aggregation_block_hash_N, aggregation_contract_hash, ''})
```

## TODO

1. Determine the set of properties that a block has, and how to determine them from a given aggregation chain. For example: validity, canonicality, insured, active, etc.
2. Determine which claim format to use. Leaning towards hash/output for simplicity. The only reason to use claim indices would be if it makes handling double-spends significantly easier.
3. Nail down some of the interfaces (params and data)

<!-- claude: On #1: the scratchpad's "What does sending the aggregation chain give?" list is a start (well-known-ness, insurance-claimed status, invalidities, double-claims). On #2: the Blocks section already decides this (direct references, "acceptable trade-off") -- suggest replacing the item with the actual open work: design the claim-mask replacement, i.e. the double-spend index / frontier-query protocol aggregators use while probing. -->


## Failure modes

1. The proof of work is not immediately verifiable as in bitcoin; it needs (1) tree sampling to pick a block to check, and (2) then to run the verifier to ensure work was done.
2. The proof of work only checks verification cost. It's possible to create many blocks that are easy to generate but have high weight. To be verified and included in an aggregation, the fee must be high enough to pay for verification. This aggregation fee is actually the weighing mechanism, more similar to a proof of burn than a proof of work. Anyone can claim them, and claims are prioritized by the size of their own aggregation fee outputs, so with competition the winning claimer will be one who sends their outputs to the next aggregation instead of their own bank account.

<!-- claude: The competition argument (claims prioritized by the claimer's own forwarded fee outputs) disciplines fees on *public* branches -- it is v1's fee-zeroing defense generalized, and it is good. The remaining hole is the *private fork*: no competitors exist there, so the attacker claims their own fees at zero net cost, and "proof of burn" mints weight for free until reveal. v1 dodged this because effective weight was *sampled verification cost*, with the fee as the market price of inclusion rather than the metric (weight-design.md). The scratchpad's fee-commitment idea helps but does not close it -- the attacker reveals only when expecting to win, and on the winning path the committed fee comes home. Suggested resolution: keep sampled verification cost as the weight metric (as the Node state section already implies) and let the fee be the economic floor; then a private fork earns only what its verifiers actually cost to run, which is real proof of work. Either way, this scenario deserves an explicit answer here. -->
