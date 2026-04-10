# Protocol Overview

This document introduces Scaffold's core concepts for readers who understand computer science fundamentals (hashes, signatures, data structures) but may not be familiar with distributed consensus, block graphs, or UTXO models. It builds concepts incrementally — each section depends on the ones before it.

For detailed specifications, see the individual module docs linked throughout.

---

## What Scaffold Does

Scaffold is a peer-to-peer protocol where browsers do the work that servers traditionally do. A browser asks a question ("what is the current price of X?" or "what happens when my character moves left?"), nearby peers race to answer it, and the protocol ensures the answer is correct — or makes it expensive to lie.

There are no privileged servers. Every participant runs the same protocol. The network reaches agreement on a shared history of computations without anyone being in charge.

---

## Why This Is Hard

The fundamental problem: two peers can independently do conflicting work, and there is no central authority to decide who wins.

Imagine Alice and Bob both try to spend the same $10. They each tell different peers about their transaction. For a brief window, some peers think Alice spent it and others think Bob did. Eventually everyone needs to agree on one version, but:

- Peers can't talk to all other peers instantly (network latency).
- Peers can join and leave at any time.
- Some peers might be lying.
- Nobody is in charge.

Every design decision in Scaffold flows from this problem. The protocol doesn't prevent conflicts — it makes them detectable and resolvable, and it makes dishonesty expensive.

---

## Blocks

A **block** is the fundamental unit of work in Scaffold. It represents a computation: "given these inputs, I ran this program and produced these outputs."

A block contains:
- **Inputs**: resources it consumes (things produced by earlier blocks).
- **Outputs**: new resources it creates (available for future blocks to consume).
- **Computation**: what program was run and what the result was.
- **Anchor**: which existing block this one builds on (its position in history).
- **Weight**: how much computational work this block represents.

Blocks are identified by their hash. Once created, a block is immutable — you can't change it without changing its hash, which makes it a different block.

Anyone can create a block. The question is whether the network will accept it as part of the shared history.

---

## Outputs

An **output** is a resource produced by a block. You can think of outputs like unique tokens: each one is created exactly once by a specific block, and can be consumed (or "claimed") at most once by a future block.

This is sometimes called the UTXO model (unspent transaction output). The key property: **an output can only be spent once**. If two blocks both try to spend the same output, they conflict — the network must choose one and reject the other.

Outputs aren't just currency. An output can represent anything: a balance, a piece of game state, a data record, a permission. What matters to the protocol is the create-once-spend-once lifecycle. The meaning of an output is defined by the application; the protocol just tracks ownership and prevents double-spending.

### Spending Conditions

Each output has a **spending condition** — a rule that determines who can consume it. The simplest condition is "only the holder of private key K can spend this." But conditions can be more complex: "spendable by anyone after time T" or "spendable only if block X is found invalid." This flexibility lets the protocol express collateral, escrow, and other financial primitives using the same output mechanism.

---

## The Block Graph

Blocks form a **directed acyclic graph** (DAG). Each block points backward to an **anchor** — the block it builds on. Following anchor links backward leads eventually to the **genesis block**, the starting point of the entire graph.

```
         [genesis]
            |
           [A]
          /    \
       [B]     [C]
       / \      |
     [D] [E]   [F]
```

Multiple blocks can anchor to the same parent, creating branches. Branches are normal — they represent parallel work happening across the network. Most branches are compatible (they don't conflict). When branches do conflict, the consensus mechanism resolves them.

This structure means there is no single chain of blocks — it's a graph. At the global level, the graph forms a **chain of trees**: a linear anchor chain where each link is the root of an aggregation tree. Blocks within a tree anchor to the root's anchor or an ancestor of it, and aggregation progressively rolls them up into a single root, which becomes the anchor for the next level. See [DAG Structure](dag.md) for the full topology.

The graph grows as peers create new blocks, and each peer maintains its own view of the graph based on which blocks it has received so far.

---

## Conflicts

Two blocks **conflict** when they both try to consume the same output. Since an output can only be spent once, the network must choose one block and exclude the other.

Conflict detection is handled by the OutputClaimModule. During claim migration, when a second claimant is placed on the same output, a double-spend conflict is detected. If two blocks both claim the same producing output, they conflict.

Conflicts are:
- **Permanent**: once detected, a conflict never goes away.
- **Symmetric**: if A conflicts with B, then B conflicts with A.
- **Inherited**: if you build on top of a conflicting block, you inherit its conflicts. Everything built on a losing branch is also excluded.

The last point is important. Conflicts don't just affect the two blocks that double-spend — they cascade forward through everything built on top of them. This means choosing the wrong branch to build on has consequences: your work may be excluded if your branch loses.

See [Conflict Module](conflict.md) for the full specification.

---

## Consensus

**Consensus** is how the network decides which block wins a conflict. The mechanism is simple: **the block with the most verified work behind it wins**.

Every block declares a **weight** — how much computational work it represents. As peers build new blocks on top of existing ones, the total weight accumulates downward: a block's **effective weight** includes its own weight plus the weight of everything built on top of it.

When two blocks conflict, compare their effective weights. The heavier one wins. Ties are broken deterministically by hash.

This means:
- **Earlier blocks are more stable**: they've had more time to accumulate descendant weight, so overturning them requires outweighing everything built on top.
- **There is no finality**: a winning block can always be overtaken if enough weight builds on the other side. But the cost grows over time, making reversals increasingly impractical.
- **Consensus is local**: each peer computes its own view based on the blocks it has seen. Peers converge as they receive the same blocks, but may temporarily disagree.

### Declared vs. Verified Weight

A block *declares* how much weight it has, but declarations aren't trusted blindly. Peers independently **verify** a block's work by spot-checking: pick a random piece of the declared computation, re-execute it, and check if the result matches. Over many spot-checks, a statistical picture emerges. Blocks whose work checks out get their full declared weight counted. Blocks that fail verification see their effective weight drop toward zero.

This sampling-based verification means peers don't need to re-execute every computation — they verify just enough to be statistically confident, making the system practical even at scale.

See [Consensus Module](consensus.md) and [Sampling Module](sampling.md) for the full specifications.

---

## Trust and Collateral

Verification catches fraud, but catching it after the fact isn't enough — we need to make fraud **expensive** so that rational actors don't attempt it. This is the role of **collateral**.

When a peer publishes a block, they can stake collateral: a separate output that says "I vouch for this block's correctness. If it's wrong, you can take my stake." Other peers can stake **against** a block: "I believe this block is invalid, and I'm willing to bet on it."

This creates a prediction market around block validity:
- **Publishers** risk their collateral if their blocks are invalid.
- **Verifiers** earn rewards for catching fraud.
- **Aggregators** (peers who roll up others' work) must assess the fraud risk before staking their own collateral.

Collateral is not a new primitive — it's a regular output with special spending conditions. The spending rules are: the winning side of a validity dispute claims the losing side's stake, up to a bounded amount proportional to the contested work.

Importantly, collateral addresses **validity** (is the computation correct?), not **conflict** (which of two valid blocks wins?). A publisher who loses a consensus race to a valid competitor bears no penalty — their collateral is returned.

See [Trust Module](trust.md) for the full specification.

---

## Aggregation

Left alone, the block graph would grow without bound — every small computation producing its own block forever. **Aggregation** is the mechanism for consolidating work.

An **aggregator** creates a new block that **aggregates** (replaces) multiple existing blocks. The aggregation block rolls up the effects of its subtrees into a single summary: one claim mask, one output set, one weight declaration. The aggregated blocks are no longer needed individually — the aggregation block represents their collective contribution.

Aggregation serves several purposes:
- **Compression**: reduces the number of blocks peers need to track.
- **Weight consolidation**: combines scattered weight into a single block with clear attribution.
- **Risk transfer**: the aggregator stakes their own collateral on the rolled-up work, allowing the original publishers to reclaim theirs.
- **Chain extension**: aggregation is what advances the anchor chain. When all work at a level is rolled up into a single root, that root becomes the anchor for the next level. See [DAG Structure](dag.md).

Aggregation has a natural economic dynamic. Aggregators earn fees (the blocks they aggregate incentivize being rolled up) but take on risk (if any subtree is fraudulent, the aggregator's collateral is at stake). This creates a speed-vs-safety tradeoff: aggregate quickly to capture fees, but probe subtrees first to bound fraud exposure.

---

## Gossip

Blocks need to reach the peers who care about them. The **gossip module** handles block distribution using a push-based approach: peers proactively send blocks they think will be useful, rather than waiting for requests.

The key challenge is efficiency. Naively forwarding every block to every peer wastes bandwidth. Instead, the gossip module learns:

- **What each peer cares about**: if peer P sends us blocks about resource R, we route R-related blocks back through P.
- **Network topology**: if peers A and B are directly connected, we stop relaying between them (they're already sharing blocks directly).
- **Reciprocity**: peers that provide useful blocks receive more bandwidth; freeloaders get less.

This learning happens automatically through a feedback loop: push a block, observe whether it was novel to the recipient, update the model. Over time, each peer builds an efficient routing table without any central coordination.

See [Gossip Module](gossip.md) for the full specification.

---

## Putting It Together

Here's how the pieces interact when a peer publishes a new block:

1. **Creation**: The peer constructs a block — choosing an anchor, consuming inputs, running a computation, producing outputs, and declaring weight.
2. **Collateral**: The peer stakes collateral vouching for the block's validity.
3. **Gossip**: The block propagates to peers who are likely to care about it.
4. **Conflict detection**: The OutputClaimModule detects conflicts during claim migration -- when a second claimant is placed on the same output, a double-spend conflict is declared.
5. **Consensus**: The new block's weight is added to its branch. If it's in a conflict, the branch with more verified weight wins.
6. **Verification**: Peers sample and spot-check the block's declared work. Verified weight converges toward declared weight for honest blocks and toward zero for fraudulent ones.
7. **Aggregation**: Eventually, an aggregator rolls up the block (and others) into a consolidated block, transferring risk and compressing the graph.

No step requires a central coordinator. Each peer processes these steps independently, and the protocol's design ensures they converge on the same outcome.

---

## Module Map

The protocol is specified across several module documents, each responsible for one concern:

| Module | Concern | Question It Answers |
|--------|---------|-------------------|
| [Consensus](consensus.md) | Branch selection | Which conflicting block wins? |
| [Conflict](conflict.md) | Double-spend detection | Do two blocks claim the same output? |
| [Sampling](sampling.md) | Weight verification & probe scheduling | How is declared work converted to verified weight? |
| [Trust](trust.md) | Economic incentives | What happens if a block is fraudulent? |
| [Gossip](gossip.md) | Block distribution | Which peers should receive this block? |
| [Block Creation](block-creation.md) | Block construction | How are blocks built, anchored, and balanced? |
| [Contracts](contracts.md) | Standard contracts | What spending conditions do protocol modules use? |
| [Weight](weight.md) | Weight derivation | How do blocks earn consensus influence through verified computation? |
| [Anchoring](anchoring.md) | Anchor resolution & output mapping | Where does a block attach, and how are outputs addressed across blocks? |
| [DAG](dag.md) | Graph topology | How do blocks form the chain of trees? |
| [Output Data](output-data.md) | Data format & contract UI | How do contracts expose params/data for reading and construction? |
| [Output Claims](output-claims.md) | Claim tracking | Who claims each output on a given block? |
| [Output Space](output-space.md) | UTXO state model | How are output spaces constructed, indexed, and transformed? |
| [Aggregation](aggregation.md) | Subtree composition | How does aggregation define ordering and cache transformations? |
| [Deception](deception.md) | Verification incentives | How does strategic fraud sustain the verification layer? |
| [Collateral Resolution](collateral-resolution.md) | Collateral contract | How are blocks challenged, validated, and rectified? |
| [Execution Queue](execution-queue.md) | Execution scheduling | How is contract execution prioritized and resource-limited? |
| [Attacks](attacks.md) | Security catalog | What attacks exist and how does the protocol defend against them? |

Each module defines its own view of what a block looks like (only the fields it cares about), its own state, and clean interfaces with the other modules. No module reaches into another's internals.

---

## Implementation

All modules live in `src/core/` and follow a provider pattern: pure logic in `*Module.ts`, wired adapters in `*Service.ts`.

| Module | Core File | Service File |
|--------|-----------|-------------|
| Consensus | [`ConsensusModule.ts`](../../src/core/ConsensusModule.ts) | [`ConsensusService.ts`](../../src/core/ConsensusService.ts) |
| Sampling | [`SamplingModule.ts`](../../src/core/SamplingModule.ts) | [`SamplingService.ts`](../../src/core/SamplingService.ts) |
| Trust | [`TrustModule.ts`](../../src/core/TrustModule.ts) | [`TrustService.ts`](../../src/core/TrustService.ts) |
| Gossip | [`GossipModule.ts`](../../src/core/GossipModule.ts) | [`GossipService.ts`](../../src/core/GossipService.ts) |
| Block Creation | [`BlockCreationModule.ts`](../../src/core/BlockCreationModule.ts) | [`BlockCreationService.ts`](../../src/core/BlockCreationService.ts) |
| Anchoring | [`AnchoringModule.ts`](../../src/core/AnchoringModule.ts) | — |
| Execution Queue | [`ExecutionQueueModule.ts`](../../src/core/ExecutionQueueModule.ts) | [`ExecutionQueueService.ts`](../../src/core/ExecutionQueueService.ts) |
| Output Claims | [`OutputClaimModule.ts`](../../src/core/OutputClaimModule.ts) | [`OutputClaimService.ts`](../../src/core/OutputClaimService.ts) |

Supporting files:

| File | Description |
|------|-------------|
| [`Block.ts`](../../src/core/Block.ts) | Concrete block type, `BlockStore`, genesis creation |
| [`OutputSpace.ts`](../../src/core/OutputSpace.ts) | Pure output-space operations: claim resolution, masks, ordering, UTXO computation |
| [`Coordinator.ts`](../../src/core/Coordinator.ts) | Orchestrates all modules: block received → conflict → consensus → gossip → sampling |
| [`ProtocolContext.ts`](../../src/core/ProtocolContext.ts) | Dependency injection container wiring all services together |
