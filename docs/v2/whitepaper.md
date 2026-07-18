# Introduction

Scaffold is a protocol enabling trusted distributed computation. V2 attempts to be a simplification and refinement of the conglomeration of v1 ideas.

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
  outputs: { contractHash: Hash, params: bytearray, data?: bytearray, amount: bigint }[];
  // Declared weight?
  // Refs?
  timestampMs: number;
}
```

### Anchor

The anchor is a hash to another larger-weight block. The anchor should be a reference to a well-known prior block that, together with the aggregates, contains all the claimed outputs.

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

### Claims

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

Sidenote: There's a couple of different ways we can specify claims. In order from simplest to most powerful:
1. A simple block hash and output index. This is simple, yet does not prove that the claimed block is included in the anchor chain. Users desire to trust a block's contents, and they do this by seeing that the block's inputs (claims and refs) are insured by well-known blocks.
2. A 3-tuple of integers: `{ chainHops, treePath, outputIndex }`. The output is resolved by following `chainHops` chain anchors, then recursively taking `block.aggregates[(treePath % block.aggregates.length) - 1]` until the path is zero, then selecting the correct output. This works but feels less elegant than the following method.
3. A single integer, an index into the entire output vector defined by the block, its anchor chain, and the anchor chain's subtrees. This is the chosen method specified above.
4. A single integer, an index into the UNCLAIMED output vector. This has the advantage of being unable to address the same claim twice, eliminating the possibility of double-spends. However, the overhead of maintaining a claim mask (potentially very large for a large aggregation) and transforming claim indexes through these likely requires hash inversions for a claim mask merkle tree, which is a lot of machinery for clients to run to simply resolve claims.

Note: option 2 would be implemented something like this:
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

### Merkle claimed/unclaimed mask

Option 4 specified indices into an unclaimed output vector, requiring the use of a claim mask to transform indices when resolving them through another block (since the unclaimed output space changes). Option 3 omits this necessity, since it indexes into a global output vector, containing both claimed and unclaimed outputs. The transformation from one block's output space into another's is a simple addition.

Detecting double-spends was a big benefit of the claim mask in option 4. This is mostly useful for aggregation, when an aggregator wants to know that he won't have to pay out double-spend claims. We can still do this, keeping a claimed/unclaimed bitvector in a merkle tree on each block, without affecting claim lookups. Normal clients will never need to index into the merkle tree, while aggregators will likely find it quite useful.

It's very simple; each block's merkle tree encodes a bitvector with a 1 set if that output index is claimed in an aggregate. The bitvector's length is `anchor.output_space_size + SUM(aggregate[*].created_outputs)`. Notably it does not include outputs or claims of the block itself.

### Outputs

An output describes funds that are only able to be retrieved by a block satisfying the given contract and parameters. Amount must be non-negative (although relaxing this restriction has some interesting mechanics we could investigate in the future).

The sum of output amounts must exactly equal the sum of claimed output amounts.

If the contract conatins an ALLOWED_PRODUCERS property, it should be interpreted as a JSON array of hashes. Only those contracts are allowed to put that output onto a block.

An output may be flagged `stalling`, which causes the block to be stalled. Stalled blocks are not aggregatable or anchorable UNLESS the descendant block claims all stalling outputs. This allows a block to not gain descendant weight until an output gets claimed.

### Timestamp

This must be greater than or equal to the timestamps of the anchor and all aggregated blocks. Generally, peers want to publish blocks with minimal timestamps, so blocks with timestamps in the future will not be aggregated or built upon by peers until that time comes to pass.

Let's say a block wants to lock funds until a date D. Then, its output contract can specify that the claiming block must have a timestamp of D or greater. Claims with timestamp D can be published even before D, but will not be aggregated or gain descendant work. As such their weight will remain small until time D.

## Conflicts

A conflict occurs when more than one block claims the same output.

Locally, a peer should give each claim a canonicality of `descendant_weight + self_weight - disqualification_penalty - misordering_penalty`
- `descendant_weight + self_weight` is sampled, verified weight from descendant trees.
- How does this work when a descendant is aggregated - is it summed twice?
- I think we aggregate the maximal cross-section of fees, and use that as the weight.
- The weight is proportional to throughput, so larger blocks will be prioritized.

`disqualification_penalty = IF(disqualified, throughput * disqualification_factor, 0)`
`misordering_penalty = IF(misordered, throughput * misordering_factor, 0)`

An invalid block or a double-spend (just one of the multiple claims) gets marked "disqualified" in some aggregator.
- Disqualified blocks are no longer elegible to be marked in a double-spend or as invalid.
- Disqualified block's canonicality gets decremented by the throughput, which gets burned.
- Any negative canonicality is flagged and propagates to descendants, which makes the whole downstream uncanonical.
- Any disqualified block doesn't participate in double-spends, so you can regenerate the claim. The new block behaves exactly the same as it would if it had been generated originally.
- A misordered aggregations is similar, although its disqualification doesn't get aggregated like an invalidity or double-spend.

A double-spend is an invalidity of the aggregator. All spends following the first one (in the canonical traversal of the tree) are disqualified.

> Note that although negative canonicalities propagate to descendants, invalidities don't. This is because lots of work could be built on an invalid block, and in this case we leave that work alone, while freeing up the original output to be claimed again. On the other hand if the descendant work doesn't exceed the throughput, the canonicality will become negative and that WILL propagate downstream, effectively making the whole branch uncanonical.

incentive = generation_cost + verification_cost <= throughput <= rectification_amount
- The rectification_amount should be approximately equal to the value of a correct solution minus the value of an incorrect solution.

Invalidity insurance payout:
- Burn `throughput` -> `{disqualify, block_hash}`, which disqualifies the block
- Pays `O(throughput)` for reward
- Note: the whole block's throughput is used, not just the claim

Double-spend insurance payout:
- Burn `throughput` -> `{disqualify, block_hash}`, which disqualifies the block
- Pays `O(throughput)` for reward
- Note: the whole block's throughput is used, not just the claim

Including or not including a double-spend depends on the fees. If the fees are large enough to compensate for the payout, we can include both.

## Consensus

Blocks are aggregated into trees. Trees can declare arbitrary weight, so instead of trusting it peers sample and evaluate locally. Peers descend a tree by sampling, at each branch choosing a child proportional to its aggregation fee. Once a leaf is reached, the peer verifies the block and measures the cost (cpu usage, memory, etc). This propagates back up the tree, scaling up by the inverse probability of sampling each child, until the root has an estimate. This can occur multiple times to get a more accurate measurement.

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

## The contract interface

The contract interface is used both during generation and verification. For example, a contract calling 

A contract has a pre-claim step that filters claims. It accepts an env, can request outputs in bulk or incrementally, and finishes by claiming the desired outputs. These are passed to the main generator/verifier step.
OR another contract that is more specific, and emits some kind of message for the main contract.
OR some kind of routing method that takes claims and routes them to appropriate contracts.
- This could be a

What if the insurance resolution is specified by the contract, based upon presented data? Like hints? I think outputs that lock funds and release it selectively are basically the same as hints.
- Slightly different because they don't make the original block invalid, which is useful to regenerate slow-responding aggregations.

You should be able to claim from a number of verifiers, and you get the one that arrives first (so claims are ordered).
- This also generalizes to claiming from a timestamp pseudo-output.

Fetch all?

What if a query can also contain a set of capabilities along with the params and data?
- Signature capability (specific private key -> void)
- Requestor contract hash

Contracts should be encouraged to read random bytes. This mixes in block hashes into the data, which helps solidify the graph, and prevents double-posting work on multiple branches.

When a contract publishes a result, it re-encodes the params canonically.

Possible contest resolution flow to discover who's currently insuring the block:
```
setTargetTimestamp(vote_resolution_timestamp)
claimer(params.block_hash, aggregation_contract_hash, '') -> aggregation_block_hash_1
claimer(aggregation_block_hash_1, aggregation_contract_hash, '') -> aggregation_block_hash_2
...
claimer(aggregation_block_hash_N, aggregation_contract_hash, '') -> undefined
send(my_claimer_of, {aggregation_block_hash_N, aggregation_contract_hash, ''}, vote_direction)
```

## Aggregation

Every block except the genesis block has a single aggregation output. An aggregation block is simply a block that claims at least 2 similarly-sized aggregation outputs. This organizes the set of blocks into a forest; a set of trees. As new blocks get created, they get aggregated into a small tree, which will eventually get aggregated into a larger tree, etc.

Each claimed block's size must be less than N% of the aggregate size. N% = 60%

Aggregations serve 4 functions:
1. Ordering the tree of blocks
2. Aggregating weight for efficient descendant work computation
3. Insuring against double-spends in any block in their subtrees
4. Insuring against failing verifiers in any block in their subtrees

> Note: This also excludes aggregating the same block is included twice, as it's aggregation output would be double-spent.

The aggregation output's game-theoretic optimal amount is `verification_cost * throughput / AVG(throughput)`

Before creating an aggregation, a peer needs to evaluate the risk/reward tradeoff. The reward is the fees paid via the aggregation outputs. The risk is the insurance they are placing, covering the blocks in their subtrees. They can reduce this risk by probing the subtrees, and if they find an issue they can claim a reward from the current insurer.

It's likely more than one peer may be probing and aggregating a given subtree. The one who becomes canonical and receives the reward is determined by the claim resolution logic, in the same way that any claim winner is determined: by the amount of derived work. Typically this is the first, so quick probers and publishers will be more profitable.

Probing tries to measure 2 risks:
1. Double-spends, sampled via ??? (frontier-throughput, but also needs to look for double-spends in the already insured subtrees)
2. Failing verifiers, sampled via throughput???

A failing query (ref, validity, etc) usually occurs while tree probing to evaluate insurability. A failing subset of N% of queries should be extrapolated to that percentage of blocks failing in the full subtree. Failing blocks mean you will pay insurance.

Aggregation contracts specify a single output to a resolution contract.

The successive aggregations of a block are called the aggregation chain. Multiple aggregation chains may exist, for example when an aggregation output is claimed multiple times, but only one will be canonical. This chain is important, for a few reasons:
1. It proves that the block is well-known and trusted. A large, well-known aggregation root with insurance implies trust in the block.
2. It proves absence of discovered invalidity or double-spends. Both of those are encoded into an aggregation.

If an aggregator A does not correctly sum the throughputs of its aggregated blocks, we say the aggregated blocks are "uninsured". The aggregator A fails validation, is disqualified, and the aggregated blocks may be aggregated again. This simply falls out of the invalidity logic, but it should be noted that once an aggregator has been disqualified (fails validation or double-spends), the path is broken. Its children and grandchildren are no longer eligible to claim insurance. Although this should hold for all kinds of disqualifications, the most important one is if throughput is not correctly summed. This should be clearly visible from the aggregation path, and any paths without correctly summed throughput are simply invalid.
- If this does not hold, a very large sub-block could be "hidden" inside an aggregation with low declared throughput, meaning it's never probed. This large sub-block should not be elegible to claim insurance payouts.

## Insurance

Insurance is parameterized by a target block hash, which is the tree root that it covers. Negative contest resolutions can be claimed, which give payouts. More funds can also be added. Payouts are drawn equally from the total fund pool. Once the target block gets aggregated, it requests the remaining insurance, which gets returned to the insurers. The fee is distributed proportionally to who funded the payouts.

OR payouts are drawn sequentially from the first fund to the last, and the first (2x the payouts) from the funds is the ratio by which the fees get distributed.

The target block's aggregator (which claims the last block in the insurance chain) includes block hashes (or paths, which might be smaller) of the newly disqualified blocks.

Remaining funds can always be withdrawn, but you lose fees. This allows insurers of non-canonical branches to regain their funds. Once this happens, that non-canonical branch loses trust because it lost insurance.

There's 2 kinds of insurance:
1. Short-term serving insurance. This is always the author's responsibility, and evaporates over a few minutes or hours. This supports inversions of hashes on the block (like refs and the anchor), and query-based validities (like non-uniqueness presentations), and pays a reward to anyone finding an issue.
2. Long-term rectification insurance. This responsibility is passed to aggregators, and never goes away. This supports verification failures, and pays the disqualification burn.

> Note that query-based invalidities mean that generation can't be automatic. Implement this as separate blocks that lock funds and selectively release it.

It's expected that a large fraction of blocks will be forgotten pretty quickly. This is why long-term insurance isn't responsible for data serving.

## The aggregation contract

There’s a well-known aggregation contract. Each block must address exactly one output to the aggregation contract. The amount represents a fee paid to the aggregator as payment, mostly to cover the insurance they will post. It’s arbitrary, but the game-theoretic optimum should be approximately equal to the verification cost (see below for a more thorough explanation).

An aggregation contract takes no parameters; this means the aggregation contract can claim any aggregation outputs.

Aggregation should also allow downstream sampling by verification cost (proportional to the fee).

## Node state

A node’s state contains:

- A set of blocks
- A set of evaluations of the weight of a block, which is the cost of validation in units of coins. Typically this is proportional to the CPU time taken to run the WASM, but could also be based on memory usage or other resources. It’s locally defined, may be noisy, but consistent weight evaluations across nodes is desired and will make consensus more efficient.
  - `weightEvaluations: { blockHash: Hash, cost: bigint }[]`

Given this state, various functions can be defined:

- The sampled weight of a subtree, parameterized by a block:
  - This is a good estimator of the actual total weight of the subtree, resistant to byzantine modifications of the children’s declared weights.

Why is the aggregation fee proportional to the verification cost? ...

## Glossary

Deeply buried: A block that has lots of descendant weight, usually quite old. Typically canonical and would be very difficult to make uncanonical.

Parent of X: A block aggregating X (claiming X's aggregation output). Although there may be multiple parents of X, only one will eventually become canonical.

Child of X: A block aggregated by X. There may be any number of children of X.

Leaf block: A block with no children (claims no aggregation outputs).

Branch block: A block with at least one child.

Tree root: A block that currently has no parents. Typically a very large aggregation. All blocks will eventually be aggregated so this is a temporal designation.

## Abandoned ideas

Aggregations recording the descendant weight of each subtree (maybe the descendant weight contained in the aggregation, from other following subtrees) instead of the weight vector. After aggregation, little else should anchor to the children. But I don’t know if this helps; you still have to compute the subtree weight somehow.

Boosting conflict resolution via a canonicality boost, block throughput metric, or claim throughput metric. These boosts have no cost to creating them, allowing an actor to add another claim to a deeply buried output, with an arbitrarily large boost, invalidating a large subset of the graph. Even throughput-based modifiers are suceptible because the account contract can simply be used to generate arbitrarily large throughputs.

The insurance payout increases the canonicality of a replacement, instead of decreasing the canonicality of the invalid block (as currently specified). This seems a little more complex, and the resulting aggregation fee will be different than the original block.

One interesting way to partition the claims or outputs of a block is into free-market transactions and selfish transactions. A free-market transaction is one that anyone can claim with approximately the same amount of effort, like the aggregation contract. A selfish transaction is one that requires private knowledge to claim, like the signature contract. Generally we want to select claims that have more free-market outputs, since that encourages competition. The question is how to differentiate the two; a whitelist is pretty centralized and contracts can't really be trusted to flag themeselves. One interesting solution is to consider conflicting claim's outputs. The difference in amounts between SHARED contract hashes can be considered a free market bonus, while contract hashes occurring on only one block are pessimistically considered selfish. A free-market flag can be used to allow a block to say an output is NOT free-market, even if the block happens to output to it.

An adaptive misordering demotion:
- For child order c₁…c_k with peer-local descendant weights w: Σ_{i<j} max(0, w_{c_j} − w_{c_i})
- Possibly multiplied by some constant factor
- Computational trick for O(N log N):
    Define two order-statistics of the sequence:
    - **T = Σ_{i<j} |w_i − w_j|** — the total pairwise spread. Order-*independent*; computable in O(k log k) by sorting once: with weights sorted ascending as w₍₁₎…w₍ₖ₎, T = Σ_r (2r − k − 1)·w₍ᵣ₎.
    - **P = Σ_j (2j − k − 1)·w_j** — a signed, position-weighted sum over the sequence *as given*. O(k), one pass.
    Then, since U counts the positive parts of (w_j − w_i) and T counts absolute values while P counts signed values over the same pairs: **U = (T + P) / 2**

What if the contract has a DECIDER or AUTHORITY or JUDGE field that contains a contract hash. The most canonical (recursive) result of `{JUDGE, block_hash}` gives the canonicality of the block.

What if there's a way to "attach" an output to another output? It could be negative, and as long as the positive one is greater and can't be claimed without the negative one, we're good.
