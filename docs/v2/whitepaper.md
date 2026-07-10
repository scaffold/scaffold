## Introduction

## Comparison to v1

One of the difficulties in an arbitrary DAG is that a large spend can be buried deep inside, and there’s no way for a node to “discover” it and check whether it’s valid or not. You can require the aggregator sum the internal size or throughput, but they could lie. The current solution is that the aggregation is canonical, not the internal block. The aggregation block contains all the information necessary for UTXO transformation. Even if a buried internal block is invalid, it’s ignored once aggregated.

The v2 change is that instead of requiring the aggregate to be internally consistent and encoding everything needed to transform the UTXO vector, it simply solidifies the output and insures any future invalidities found inside its subtree. Contrary to v1, double-spends don’t mean the aggregation is invalid, just that coins must be burned from the insurance to ensure the total throughput is constant. Inputs must equal outputs. Misdirected funds (for example a block invalidly claiming an ouput) are marked invalid, allowing the output to be spent a second time, and the insurance burns some funds to make the throughput equal.

## Blocks

A block is an immutable byte array, typically represented by its hash. A block has these explicit properties serialized into the byte array:

- Anchor
- Active chain depth
  - This is the number of blocks in the anchor chain whose subtrees contain all claims.
- Weight vector
- `claims: { blockHash: Hash, outputIndex: integer }[]`
    - A claim signifies that the block fulfills the contract and parameters specified by the referenced output: `getBlock(claim.blockHash).outputs[claim.outputIndex]`
- `outputs: { contractHash: Hash, params: bytearray, data?: bytearray, amount: bigint }[]`
    - An output describes funds that are only able to be retrieved by a block satisfying the given contract and parameters.
    - Amount must be non-negative (although relaxing this restriction has some interesting mechanics we could investigate in the future)
- `results: { contractHash: Hash, params: bytearray, result: bytearray }[]`
    - A set of capabilities, each represented by a contract hash?
- Declared weight?
- Refs?
- Timestamp?

The sum of claimed amounts and output amounts must be equal: `SUM(getBlock(claim.blockHash).outputs[claim.outputIndex].amount for claim in block.claims) == SUM(output.amount for output in block.outputs)`

Its hash is not an explicit property; it is implicit; computed from the byte array.

> Why are claims specified by a direct reference (blockHash + outputIndex) instead of simply a claim index like in v1? A claim index is small and can easily be aggregated into a claim mask, which is easy to check for double-spends when aggregating. However resolving a claim from block A requires the anchor chain of A (which is usually available) and the aggregation chain down to the outputting block. It also requires a claim mask lookup at every anchor chain jump, which requires a network request if it's not already in cache.
>
> A direct reference is faster to lookup but requires more probing to prevent double-spends while aggregating. This is an acceptable trade-off.

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

Aggregation blocks specify a single output to a resolution contract.

## Resolution



## The aggregation contract

There’s a well-known aggregation contract. Each block must address exactly one output to the aggregation contract. The amount represents a fee paid to the aggregator as payment, mostly to cover the insurance they will post. It’s arbitrary, but the game-theoretic optimum should be approximately equal to the verification cost (see below for a more thorough explanation).

An aggregation contract takes no parameters; this means the aggregation contract can claim any aggregation outputs. It takes a data field matching this schema:

```tsx
interface AggregationChildData {
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

It outputs to a funds management contract, which claims payout proofs. It outputs to the payout address, and the remainder to the same funds management contract.

An aggregation contract can be challenged. A challenge has an amount and is one of these types:

- Block invalidity
- Double-spend

A block challenge is local (can only be performed once, even if insurance is delegated). It outputs to the insurance policy that claimed the block’s insurance output. This happens recursively, until the insurance resolution gets paid.

A challenge/vote is an output.

Aggregation should also allow downstream sampling by verification cost (proportional to the fee).

### Example

```
A -> B -> C -> D -> E (amount =10)
throughput is 50
aggregated into F

```

## Node state

A node’s state contains:

- A set of blocks
- A set of evaluations of the weight of a block, which is the cost of validation in units of coins. Typically this is proportional to the CPU time taken to run the WASM, but could also be based on memory usage or other resources. It’s locally defined, may be noisy, but consistent weight evaluations across nodes is desired and will make consensus more efficient.
    - `weightEvaluations: { blockHash: Hash, cost: bigint }[]`

Given this state, various functions can be defined:

- The sampled weight of a subtree, parameterized by a block:
    - This is a good estimator of the actual total weight of the subtree, resistant to byzantine modifications of the children’s declared weights.
- Derived weight

Why is the aggregation fee proportional to the verification cost? …

Contracts should be encouraged to read random bytes. This mixes in block hashes into the data, which helps solidify the graph, and prevents double-posting work on multiple branches.

---

## Scratchpad

<!--Stolen funds just allow a double-spend. It's just an incentive to the next insurance aggregator because they'll have to rectify a double-spend.-->
It can be claimed by any descendant, given a proof of inclusion, and proof of exclusion of prior claims. Use hash inversion fetches to not duplicate block data in the proof.
Every leaf is indexed. Every potential insurance payout is indexed. At insurance aggregation time, the payouts are sealed and sent to their destinations. The aggregator can walk hashes backwards to explore the prior payouts.

Technically we can just commit the "found invalidities" vector to the aggregation block itself. Even for very large aggregations, most of the invalidities will have already been discovered so there won't be too many left.

An invalid block can be found late. It should be invalidated at the current insurance output. This invalidity means a future spend (1) won't be considered uncanonical, and (2) won't cause aggregations double-spend liabilities.

The proof of block inclusion in insurance should also prove it hasn't already been invalidated.

A challenge is parameterized by the "election", which is the block and thing being challenged. It gets as side-input a proof and an insurance.

If a sub-insurance is found to have mismatching inputs and outputs, it needs to be propagated up to the top of the insurance tree.

What are the rules of canonicality?

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

Output to a contract that can only be claimed by a descendant of B. This is incentive that B will be canonical.
OR
Output to a burn contract,

Negative outputs?

A block is insured IF its insurance chain's throughputs match the parent's declared throughput. If it does not, the incorrectly insuring block is marked invalid, eligible for another to take its place. It is effectively un-aggregated, and that section of the subtree in the original aggregation is unable to generate proofs through the incorrectly insuring block.

Does aggregation throughout need to be insured? Yes because it’s a claim from somewhere else.

Blocks are insured by outputting to a contract that claims the aggregation fee and can be claimed in part to respond to queries and payouts. 

Aggregation outputs get collected into a single block. This block can be recreated to add more insurance inputs. Inputs can be addressed to the insurer of a specific sub tree root hash. This is committing insurance, if the tree root doesn’t become canonical it’s lost. More useful is probably just publishing a new insurance pool chain link that adds funds addressed by public key. Or you commit the aggregation fee instead of the insurance. That seems nicest because it is a sunk cost, promoting canonicality. Or you commit to insuring a block, and the insurance happens whether or not the block is canonical. You can always get the insurance back (whatever remains), but you only get the fee if the root is canonical. This incentivizes you to only aggregate canonical blocks. The aggregator also claims contests from the sub trees and resolves and releases collateral.

Contests are separate contracts. A contest vote is an output that gets claimed by the resolution block. If it’s a negative resolution, it can claim the instance output and emit a diminished amount.

When the insurer is aggregated, it fetches or claims the contest resolutions to track which contests have been paid already.

Maybe even more insurance can be added to these resolutions. If the insurance runs out, no more can be claimed. This should behave the same as no insurance. 

Nodes use insurance to trust blocks. The amount of remaining insurance divided by the block in question’s throughput is a good measure of confidence. 

But a block pays an aggregation fee to fully insure the block. It should get that. I’m not sure how to determine the required amount. 

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
        
- What about invalidities?
    - Invalidities that have already claimed insurance should probably not be selected against because we want to penalize the aggregators of invalid blocks.
    - I think we include invalidities like normal.

If A=20 and B=10 conflict, and B=10 and C=5 conflict, then:
- B is uncanonical because it fails in conflict with A
- C is uncanonical because it fails in conflict with B

Even uncanonical blocks should be insured or collateralized, but not included in the tree.
Invalid blocks should be included in the tree. However they should not contribute weight. This happens because the aggregation fee likely prices it out.

What if aggregations recorded the descendant weight of each subtree instead of the weight vector. After aggregation, little else should anchor to the children. But I don’t know if this helps; you still have to compute the subtree weight somehow.

If you aggregate weight vectors, you have to be pessimistic based on the children’s anchor chains instead of their anchors’ parents.

<aside>
💡

Note this is different than the v1 behavior, which was to attribute children’s weight to aggregators.

</aside>


What about a contract calling out to another contract that can filter claims, for example, but doesn't influence the generator state except for the returned data. It passes data by adding claims or outputs.


Descendant work is the work that will be lost if a block is not canonical.
What if we can include all or most of the descendant work in the aggregation? Why wouldn't we be able to? Because it might be trees not checked yet.
What if, instead of claiming those trees, we just reference them. We're responsible for serving them, and the ordering we place claims in must match the descendant work we uncover.


What does the aggregation define? Is it the canonical composition of blocks?
- Yes. An aggregation with invalid throughput means the sub-block is ignored; any claimed outputs are still available.
- Any outputs underneath an aggregation with invalid throughput are ignored.

Should claims be index-based or block/output based?
- Block/output based is simpler.
- Queries are called during aggregation. They need to probe (1) validity by sampling based on throughput, and (2) double-spends by probing claims
- Queries are used to probe for double-spends, probe for validity, and probe for refs.
- Queries are: give me the input frontier and output frontier
- The claim mask approximately doubles the bandwidth to lookup a claim.

What about an anti-anchor; an anchor that excludes claims made by the subtree. It must be in the anchor chain, and no claims can exist at it or as an ancestor of it. This lets you efficiently skip a subtree if it only claims outputs in an un-interesting tree. <-- I think we do this
- More generally, keep a vector of the weight and throughput for each chain link.
- `chain: { weight: bigint, throughput: bigint }[]`

Who is on the hook for pending ref inversions?
- Anyone can respond to them (they're just hash inversions), but you can claim it against a block, who will be invalid until it's resolved. It must be immediately clear that the block is responsible for it. An aggregation can't serve the entire tree.
- This invalidity isn't covered by insurance. Just the block collateral.
- What's the difference?

I think aggregation query responses can be optional. if you don’t respond, the aggregation won’t be used.

What's the definite way of determining whether a block is active or not, wrt to a tree root?
Do I need respect to a tree root? YES. It tells you the block is well-known.

What does sending the aggregation chain give?
- It tells you whether insurance has been claimed against the block (not necessarily if a contest has been won but not yet claimed). This includes invalidities and double-claims.
- Most importantly, it tells you the block is well-known.

## TODO

1. Determine the set of properties that a block has, and how to determine them from a given aggregation chain. For example: validity, canonicality, insured, active, etc.
2. Determine which claim format to use. Leaning towards hash/output for simplicity. The only reason to use claim indices would be if it makes handling double-spends significantly easier.
3. Nail down some of the interfaces (params and data)

## Failure modes

1. The proof of work is not immediately verifiable as in bitcoin; it needs (1) tree sampling to pick a block to check, and (2) then to run the verifier to ensure work was done.
2. The proof of work only checks verification cost. It's possible to create many blocks that are easy to generate but have high weight. To be verified and included in an aggregation, the fee must be high enough to pay for verification. This aggregation fee is actually the weighing mechanism, more similar to a proof of burn than a proof of work.
