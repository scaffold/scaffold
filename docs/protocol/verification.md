# Verification Approaches

This document surveys approaches for gaining higher confidence in Scaffold's protocol correctness — from formal verification tools that prove properties mathematically, to adversarial testing that tries to break the protocol empirically. Each approach targets different layers of the protocol and provides different kinds of guarantees.

The approaches are ordered roughly by practicality: most actionable first, most ambitious last.

---

## Summary

| Approach | What It Proves | Scaffold Target | Effort | Confidence Gain |
|----------|---------------|-----------------|--------|-----------------|
| [TLA+](#tla-temporal-logic-of-actions) | Safety/liveness of state machines | Consensus, conflict, canonical view | 2-4 months | High for protocol design bugs |
| [Tamarin Prover](#tamarin-prover) | Cryptographic authentication | Block signatures, spending conditions | 1-2 months | High for crypto-layer attacks |
| [Dafny](#dafny) | Algorithm correctness | Weight calculation, DAG invariants, bit vectors | 1-3 months | High for implementation bugs |
| [Ivy](#ivy) | Parameterized safety | Consensus for any N nodes | 2-4 months | Very high (unbounded) |
| [F\*](#f-f-star) | Full-stack verified implementation | Everything (theory) | 6-12 months | Highest possible |
| [AI-Adversarial Testing](#ai-adversarial-testing) | Nothing formally; finds bugs empirically | Full protocol | 2-4 months setup | Complements formal methods |

---

## TLA+ (Temporal Logic of Actions)

TLA+ is Leslie Lamport's specification language for modeling concurrent and distributed systems. It describes a protocol as a state machine — a set of variables, an initial state, and a set of actions that transition between states. The TLC model checker exhaustively explores the reachable state space and reports any invariant violations. Apalache extends TLC with SMT-based symbolic model checking for larger state spaces.

### Assumptions

- **Interleaving concurrency**: Actions are atomic; the model checker explores all possible orderings. This is a good fit for Scaffold — block arrivals, conflict declarations, and weight updates are naturally atomic events.
- **Finite state space (TLC)**: The model checker enumerates states, so you fix small bounds (e.g., 5 blocks, 3 peers). Bugs found in small instances almost always generalize.
- **Bounded depth (Apalache)**: Symbolic checking avoids explicit enumeration but checks executions up to a bounded number of steps.
- **No cryptographic reasoning**: Signatures and hashes are opaque identifiers. TLA+ trusts that `hash(x) != hash(y)` when `x != y` — it does not model collision resistance or forgery.
- **Byzantine behavior is manual**: You model dishonest peers as processes that can take arbitrary actions (send any message, declare any weight). The tool does not provide an adversary model; you construct one.

### What It Can Prove

**Safety invariants** (things that must never happen):
- No two conflicting blocks appear in any honest peer's canonical view.
- Conflict detection is monotonic — once declared, never retracted.
- Effective weight computation is canonical-independent (does not change based on conflict resolution iteration).
- Conflict inheritance is transitive through aggregation.
- Value conservation holds across all blocks.

**Liveness properties** (things that must eventually happen, under fairness assumptions):
- If all honest peers receive the same set of blocks, they converge on the same canonical view.
- A block with higher verified weight eventually wins its conflict.

**What it cannot prove**: Anything about cryptographic security (signature forgery, hash collisions), game-theoretic equilibria, or properties that hold for unbounded system sizes.

### Code Sample

This models the core of the consensus module: blocks anchor to parents, conflicts are detected, and the canonical view includes only non-conflicting winners by effective weight.

```tla
---- MODULE ScaffoldConsensus ----
EXTENDS Integers, FiniteSets

CONSTANTS
    MaxBlocks,       \* bound on number of blocks
    GenesisHash      \* distinguished genesis block

VARIABLES
    blocks,          \* set of block hashes that exist
    anchor,          \* anchor[b] = hash of b's parent
    weight,          \* weight[b] = verified weight of b
    conflicts,       \* set of {a, b} pairs (unordered)
    canonical        \* current canonical view (set of hashes)

vars == <<blocks, anchor, weight, conflicts, canonical>>

\* --- Helpers ---

\* Descendants of b: all blocks that anchor (directly or transitively) to b
Descendants(b) ==
    LET RECURSIVE Desc(_)
        Desc(s) == LET children == {c \in blocks : anchor[c] \in s}
                   IN IF children \subseteq s THEN s
                      ELSE Desc(s \cup children)
    IN Desc({b}) \ {b}

\* Effective weight: own weight + weight of all descendants
EffWeight(b) == weight[b] +
    LET desc == Descendants(b)
    IN IF desc = {} THEN 0
       ELSE LET Sum[S \in SUBSET desc] ==
                IF S = {} THEN 0
                ELSE LET x == CHOOSE x \in S : TRUE
                     IN weight[x] + Sum[S \ {x}]
            IN Sum[desc]

\* Does b win against all its conflicts?
Wins(b) ==
    \A c \in blocks :
        {b, c} \in conflicts =>
            \/ EffWeight(b) > EffWeight(c)
            \/ (EffWeight(b) = EffWeight(c) /\ b < c)  \* tiebreak by hash

\* --- Safety invariants ---

\* No two conflicting blocks are both canonical
NoConflictsInCanonical ==
    \A a, b \in canonical : {a, b} \notin conflicts

\* Conflict symmetry (structural)
ConflictSymmetry ==
    \A pair \in conflicts : Cardinality(pair) = 2

\* Every canonical block wins its conflicts
CanonicalIsWinner ==
    \A b \in canonical :
        \A c \in blocks : {b, c} \in conflicts => EffWeight(b) >= EffWeight(c)

\* --- Actions ---

\* A new block is created anchoring to an existing block
CreateBlock(b, anch, w) ==
    /\ b \notin blocks
    /\ Cardinality(blocks) < MaxBlocks
    /\ anch \in blocks
    /\ blocks' = blocks \cup {b}
    /\ anchor' = [anchor EXCEPT ![b] = anch]
    /\ weight' = [weight EXCEPT ![b] = w]
    /\ UNCHANGED <<conflicts, canonical>>

\* A conflict is discovered between two blocks
DeclareConflict(a, b) ==
    /\ a \in blocks /\ b \in blocks /\ a /= b
    /\ {a, b} \notin conflicts
    /\ conflicts' = conflicts \cup {{a, b}}
    /\ canonical' = {x \in blocks : Wins(x)' \/
           ~(\E y \in blocks : {x, y} \in conflicts')}
    /\ UNCHANGED <<blocks, anchor, weight>>

Init ==
    /\ blocks = {GenesisHash}
    /\ anchor = [b \in 1..MaxBlocks |-> 0]
    /\ weight = [b \in 1..MaxBlocks |-> 0]
    /\ conflicts = {}
    /\ canonical = {GenesisHash}

Next == \E b, a \in 1..MaxBlocks, w \in 0..10 :
    \/ CreateBlock(b, a, w)
    \/ DeclareConflict(b, a)

Spec == Init /\ [][Next]_vars

====
```

Run with: `tlc ScaffoldConsensus.tla` (after setting `MaxBlocks = 5, GenesisHash = 0`).

### Effort Estimate

| Task | Time | Lines |
|------|------|-------|
| Consensus + conflict core | 3-4 weeks | 300-500 |
| Aggregation + weight vectors | 2-3 weeks | 200-400 |
| Sampling module (Beta distributions) | 1-2 weeks | 100-200 |
| Multi-peer gossip model | 2-3 weeks | 300-500 |
| Invariant discovery + debugging | 2-4 weeks | — |
| **Total** | **2-4 months** | **900-1600** |

Requires familiarity with TLA+. First-time users should add 2-4 weeks for learning.

### Confidence Gain

**High for protocol design bugs.** TLC exhaustively checks all reachable states within the bounds. If an invariant holds for 5 blocks and 3 peers, it almost certainly holds in general (though this is not a proof — Apalache with induction gets closer). This is the single best tool for catching subtle interaction bugs between modules (e.g., "aggregation + conflict inheritance + weight update" creates a state where two conflicting blocks are both canonical).

**Does not replace**: Cryptographic proofs, implementation testing, or game-theoretic analysis.

### Prior Art

- **DAG-based consensus in TLA+**: Formal TLA+ specs exist for DAG-Rider, Cordial Miners, Hashgraph, and BullShark ([arxiv.org/html/2407.02167](https://arxiv.org/html/2407.02167v1)). These are 500-700 lines each and verify safety properties. Scaffold's consensus is simpler than BFT consensus (no voting rounds), so a spec should be shorter.
- **CBC Casper**: Trail of Bits published a [TLA+ analysis](https://blog.trailofbits.com/2019/10/25/formal-analysis-of-the-cbc-casper-consensus-algorithm-with-tla/) of CBC Casper consensus.
- **Apalache** has been used for ZKsync and Aztec governance protocols (2024-2025) and the Tendermint light client.

---

## Tamarin Prover

Tamarin is a security protocol verifier from ETH Zurich. It models cryptographic primitives symbolically — signatures, hashes, and encryption are abstract functions with algebraic properties (e.g., `verify(sign(msg, sk), msg, pk(sk)) = true`). The tool proves properties for all possible protocol executions with an unbounded number of sessions and participants, against a Dolev-Yao network adversary.

### Assumptions

- **Dolev-Yao adversary**: The adversary fully controls the network — it can intercept, delay, reorder, replay, and inject messages. But it cannot break cryptographic primitives: it cannot invert a hash, forge a signature without the key, or decrypt without the decryption key. This models protocol-level attacks, not implementation bugs or side channels.
- **Symbolic crypto**: Cryptographic operations are uninterpreted functions with equational rules. `hash(x)` is a black box; the only thing the adversary knows is that `hash(x) = hash(y)` implies `x = y`. This is stronger than needed for some properties (the adversary is very powerful) but weaker for others (it cannot model computational assumptions like the discrete log problem).
- **Unbounded sessions**: The proof holds for any number of peers creating any number of blocks. No finite-state limitation.

### What It Can Prove

**Authentication**: If a peer verifies a block's signature as belonging to creator C, then C actually created that block (or C's key was compromised). This is the core property for block integrity.

**Spending condition enforcement**: No adversary can claim an output without satisfying the spending condition. For example:
- A signature-contract output cannot be spent without the owner's private key.
- A collateral output cannot be claimed without the correct dispute resolution outcome.
- A timelock output cannot be spent before the required depth.

**Non-repudiation**: A block creator cannot deny creating a block whose signature verifies.

**What it cannot prove**: Consensus convergence, weight calculation correctness, game-theoretic properties, liveness, or anything about the DAG structure. Tamarin reasons about message authentication, not distributed state machines.

### Code Sample

This models block creation and verification, proving that an adversary cannot forge blocks for honest peers.

```tamarin
theory ScaffoldBlockAuth
begin

builtins: signing, hashing

/* --- Key infrastructure --- */

// Each peer generates a long-term signing key
rule Generate_Key:
    [ Fr(~sk) ]
  --[ GeneratedKey($Peer, pk(~sk)) ]->
    [ !Ltk($Peer, ~sk), !Pk($Peer, pk(~sk)), Out(pk(~sk)) ]

// Key compromise: adversary learns a peer's secret key
rule Compromise_Key:
    [ !Ltk($Peer, sk) ]
  --[ Compromised($Peer) ]->
    [ Out(sk) ]

/* --- Block creation --- */

// Honest peer creates a block
rule Create_Block:
    let blockData = <$anchor, $weight, outputs>
        blockHash = h(blockData)
        sig = sign(blockHash, sk)
        block = <blockData, pk(sk), sig>
    in
    [ !Ltk($Creator, sk), Fr(~nonce) ]
  --[ Created($Creator, blockHash, block) ]->
    [ Out(block), !PublishedBlock($Creator, blockHash) ]

/* --- Block verification --- */

// Any peer verifies a received block's signature
rule Verify_Block:
    let blockData = <anchor, weight, outputs>
        blockHash = h(blockData)
        block = <blockData, creatorPk, sig>
    in
    [ In(block) ]
  --[ Verified(blockHash, creatorPk)
    , Eq(verify(sig, blockHash, creatorPk), true)
    ]->
    [ VerifiedBlock(blockHash, creatorPk) ]

/* --- Collateral spending condition --- */

// Collateral output: can only be claimed with valid dispute outcome
rule Place_Collateral:
    [ !Ltk($Staker, sk), Fr(~id) ]
  --[ PlacedCollateral(~id, $Target, $Side) ]->
    [ !Collateral(~id, $Target, $Side, pk(sk), sign(<~id, $Target, $Side>, sk)) ]

// Collateral claim requires matching resolution
rule Claim_Collateral:
    [ !Collateral(id, target, side, stakerPk, stakerSig)
    , !Resolution(target, winningSide)     // dispute outcome
    ]
  --[ ClaimedCollateral(id, target, side)
    , Eq(side, winningSide)                // must be on winning side
    ]->
    [ Out(<'claimed', id>) ]

/* --- Security properties --- */

// Authentication: verified block was created by claimed creator
// (unless creator's key was compromised)
lemma block_authentication:
    "All blockHash creatorPk #i.
        Verified(blockHash, creatorPk) @ #i
        ==> (Ex creator #j. Created(creator, blockHash, <data, creatorPk, sig>) @ #j)
            | (Ex creator #r. Compromised(creator) @ #r & !Pk(creator, creatorPk))"

// No forgery without key compromise
lemma no_forgery:
    "All blockHash pk #i.
        Verified(blockHash, pk) @ #i
        ==> (Ex peer #j. GeneratedKey(peer, pk) @ #j &
             (Ex #c. Created(peer, blockHash, block) @ #c)
                | (Ex #r. Compromised(peer) @ #r))"

// Collateral safety: cannot claim collateral on losing side
lemma collateral_safety:
    "All id target side #i.
        ClaimedCollateral(id, target, side) @ #i
        ==> Ex #j. PlacedCollateral(id, target, side) @ #j"

end
```

Run with: `tamarin-prover ScaffoldBlockAuth.spthy --prove`

### Effort Estimate

| Task | Time |
|------|------|
| Block signature authentication | 1-2 weeks |
| Spending conditions (signature, collateral, timelock) | 2-3 weeks |
| Collateral lifecycle (place, dispute, resolve, claim) | 2-3 weeks |
| Peer handshake / block exchange protocol | 2-3 weeks |
| **Total** | **1-2 months** |

Tamarin has a steep learning curve (multiset rewriting rules are unfamiliar to most developers), but the Scaffold-relevant models are relatively small. The main difficulty is getting the tool to terminate — complex models often require manual lemmas ("oracles") to guide the prover.

### Confidence Gain

**High for the cryptographic layer.** Tamarin proofs are unbounded — they hold for any number of peers and any number of blocks. If Tamarin proves that block authentication holds, it holds against any Dolev-Yao adversary with any strategy. This is the right tool for answering "can an adversary forge blocks, bypass spending conditions, or steal collateral?" The answer will be either "no" (with a machine-checked proof) or "yes" (with a concrete attack trace).

**Does not replace**: Protocol-level reasoning about consensus, weight, or conflicts.

### Prior Art

- **TLS 1.3** was formally verified with Tamarin (the definitive security analysis).
- **Signal protocol** (Double Ratchet) was verified in Tamarin.
- **Apple iMessage PQ3** verified in Tamarin.
- **Aggregate signatures for blockchain** modeled in Tamarin (ETH Zurich, 2025).

---

## Dafny

Dafny is a verification-aware programming language from Amazon's Automated Reasoning Group. You write code with pre/postconditions and loop invariants; the compiler uses the Z3 SMT solver to verify them before generating executable code. It compiles to C#, Java, JavaScript, Go, and Python.

### Assumptions

- **Sequential execution**: Dafny verifies single-threaded algorithms. It does not model concurrent or distributed behavior. You verify the correctness of individual functions and data structures, not the protocol's distributed execution.
- **Trusted axioms**: Cryptographic primitives (hash, sign, verify) are modeled as uninterpreted functions with assumed properties. Dafny trusts these axioms — it does not verify them.
- **Termination required**: Every function and loop must terminate. You provide `decreases` clauses (variant functions) to prove this.

### What It Can Prove

**Algorithmic correctness**: Given correct inputs, the function produces correct outputs. For example:
- `resolveConflict(a, b)` returns the block with higher effective weight.
- `rebaseClaims(mask, chain)` produces a correctly rebased claim mask.
- `computeWeightVector(subtrees)` returns the correct weight attribution.
- `detectConflict(mask1, mask2)` returns true iff the masks overlap.

**Data structure invariants**: The block store maintains structural invariants at all times:
- Every block's anchor exists in the store (or is the zero hash).
- The DAG is acyclic.
- Weight vectors have correct dimensions.
- Throughput balancing holds (input values = output values).

**Absence of runtime errors**: No array out-of-bounds, no integer overflow, no null dereference.

**What it cannot prove**: Distributed protocol properties (convergence, Byzantine tolerance), cryptographic security, game-theoretic equilibria.

### Code Sample

This verifies the weight-ratio aggregation constraint and conflict detection via claim mask intersection.

```dafny
// A bit vector for claim masks
type ClaimMask = seq<bool>

// Two claim masks conflict iff they share a set bit
function method Conflicts(m1: ClaimMask, m2: ClaimMask): bool
    requires |m1| == |m2|
{
    exists i :: 0 <= i < |m1| && m1[i] && m2[i]
}

// Conflict detection is symmetric
lemma ConflictSymmetry(m1: ClaimMask, m2: ClaimMask)
    requires |m1| == |m2|
    ensures Conflicts(m1, m2) == Conflicts(m2, m1)
{}

// Conflict detection with partial knowledge: if a submask
// already shows a conflict, the full mask also conflicts
lemma MonotonicConflict(partial: ClaimMask, full: ClaimMask, other: ClaimMask)
    requires |partial| == |full| == |other|
    requires forall i :: 0 <= i < |partial| ==> partial[i] ==> full[i]
    ensures Conflicts(partial, other) ==> Conflicts(full, other)
{
    if Conflicts(partial, other) {
        var i :| 0 <= i < |partial| && partial[i] && other[i];
        assert full[i] && other[i];
    }
}

// Weight calculation
function SumWeights(w: seq<nat>): nat
    decreases |w|
{
    if |w| == 0 then 0 else w[0] + SumWeights(w[1..])
}

// Aggregation weight-ratio constraint
predicate CanAggregate(w1: nat, w2: nat, K: nat)
    requires K > 0
{
    w1 > 0 && w2 > 0 &&
    (if w1 >= w2 then w1 <= K * w2 else w2 <= K * w1)
}

// Weight-ratio constraint is symmetric
lemma AggregationSymmetry(w1: nat, w2: nat, K: nat)
    requires K > 0
    ensures CanAggregate(w1, w2, K) == CanAggregate(w2, w1, K)
{}

// Throughput balancing: inputs = outputs
predicate ThroughputBalanced(inputValues: seq<nat>, outputValues: seq<nat>)
{
    SumWeights(inputValues) == SumWeights(outputValues)
}

// Verified block creation
method CreateBlock(
    anchorOutputs: seq<nat>,
    claims: seq<nat>,        // indices into anchorOutputs
    newOutputValues: seq<nat>
) returns (claimMask: ClaimMask)
    requires forall i :: i in claims ==> 0 <= i < |anchorOutputs|
    requires ThroughputBalanced(
        seq(|claims|, (i: nat) requires 0 <= i < |claims| =>
            anchorOutputs[claims[i]]),
        newOutputValues
    )
    ensures |claimMask| == |anchorOutputs|
    ensures forall i :: 0 <= i < |claimMask| ==>
        (claimMask[i] <==> i in claims)
{
    claimMask := seq(|anchorOutputs|, (i: nat) requires 0 <= i < |anchorOutputs| =>
        i in claims);
}
```

Verify with: `dafny verify ScaffoldVerification.dfy`

### Effort Estimate

| Task | Time |
|------|------|
| Claim mask operations (conflict detection, rebasing) | 2-3 weeks |
| Weight vector derivation + aggregation constraints | 2-3 weeks |
| Block store invariants (DAG acyclicity, anchor validity) | 1-2 weeks |
| Throughput balancing | 1 week |
| Sampling module (Beta distribution math) | 1-2 weeks |
| **Total** | **1-3 months** |

Dafny has the lowest learning curve of the formal tools listed here. The syntax is familiar (imperative, C#-like), and VS Code integration provides real-time feedback on verification status.

### Confidence Gain

**High for implementation correctness.** Dafny catches off-by-one errors, missed edge cases, and violated invariants that testing would miss. The verified code can be compiled to JavaScript, which could eventually serve as a reference implementation alongside the TypeScript codebase.

**Particularly valuable for**: The bit vector / claim mask operations (where index arithmetic is error-prone), weight vector derivation (where the attribution across chain depths is subtle), and rebasing (where output indices shift through transformations).

**Does not replace**: Protocol-level verification (TLA+), cryptographic proofs (Tamarin), or distributed testing.

### Prior Art

- **Ethereum EVM bytecode** verified in Dafny (ConsenSys, 2025) — proved absence of stack under/overflows.
- **Incremental Merkle tree algorithm** verified in Dafny.
- **Smart contract reentrancy** analysis in Dafny (2024).

---

## Ivy

Ivy is a verification tool from Microsoft Research (Ken McMillan) designed specifically for distributed protocols. Unlike TLC (which checks finite instances), Ivy proves properties for **all** system sizes — any number of nodes, any number of blocks, any number of messages. It achieves this by restricting specifications to a decidable fragment of first-order logic (effectively propositional / stratified quantifier alternation), guaranteeing that the SMT solver always terminates.

### Assumptions

- **First-order logic (decidable fragment)**: All specifications must fit within the EPR (effectively propositional) fragment or its extensions. This means: no unbounded arithmetic, no nested quantifier alternations over the same sort. Some natural properties require manual decomposition to fit these restrictions.
- **No built-in crypto**: Signatures and hashes are abstract relations, like TLA+.
- **Byzantine behavior is explicit**: You model dishonest nodes as processes with unconstrained actions.
- **Parameterized**: Proofs hold for any N (number of blocks, peers, etc.), not just finite instances.

### What It Can Prove

**Parameterized safety**: For all system sizes and all possible interleavings:
- No conflicting blocks coexist in any honest peer's canonical view.
- Conflict inheritance through aggregation is correct.
- Effective weight computation is deterministic given the same block graph.
- Two honest peers with the same block set compute the same canonical view.

**Inductive invariants**: Ivy finds and verifies inductive invariants — properties that hold in the initial state and are preserved by every action. This is strictly stronger than bounded model checking.

**What it cannot prove easily**: Properties involving arithmetic (weight comparisons, Beta distributions) push against the decidability boundary. Liveness is supported but more complex.

### Code Sample

This models conflict detection and canonical view safety as parameterized invariants.

```ivy
#lang ivy1.7

type block
type output_idx

# --- Relations ---
relation anchor(B: block, A: block)
relation claims(B: block, O: output_idx)
relation conflicts(B: block, C: block)
relation canonical(B: block)
relation is_genesis(B: block)

# Weight comparison (abstract — no arithmetic)
relation heavier(B1: block, B2: block)
axiom heavier(X, Y) & heavier(Y, Z) -> heavier(X, Z)  # transitive
axiom ~heavier(X, X)                                    # irreflexive

# --- Conflict detection ---

# Two blocks conflict if they claim the same output
# and share an anchor
axiom claims(B1, O) & claims(B2, O) & B1 ~= B2 &
    anchor(B1, A) & anchor(B2, A) -> conflicts(B1, B2)

# Conflict symmetry
axiom conflicts(X, Y) -> conflicts(Y, X)

# Aggregation and conflict inheritance
relation aggregates(Agg: block, Child: block)
axiom aggregates(Agg, Child) -> conflicts(Agg, Child)
axiom aggregates(Agg, Child) & conflicts(Child, X) &
    X ~= Agg -> conflicts(Agg, X)

# --- Safety invariants ---

# Core safety: no two conflicting blocks in canonical view
invariant canonical(B1) & canonical(B2) -> ~conflicts(B1, B2)

# Canonical blocks are winners
invariant canonical(B) & conflicts(B, C) ->
    heavier(B, C) | B = C

# Genesis is always canonical
invariant is_genesis(G) -> canonical(G)

# Genesis never conflicts
invariant is_genesis(G) -> ~conflicts(G, X)

# --- Actions ---

action create_block(b: block, a: block) = {
    require ~is_genesis(b);
    anchor(b, a) := true;
}

action declare_conflict(b1: block, b2: block) = {
    require b1 ~= b2;
    conflicts(b1, b2) := true;
    conflicts(b2, b1) := true;

    # Update canonical view: loser is removed
    if heavier(b1, b2) {
        canonical(b2) := false;
    } else {
        if heavier(b2, b1) {
            canonical(b1) := false;
        }
        # Tie: break by some deterministic rule (elided)
    }
}

export create_block
export declare_conflict
```

Verify with: `ivy_check scaffold_consensus.ivy`

### Effort Estimate

| Task | Time |
|------|------|
| Conflict detection + inheritance | 2-3 weeks |
| Canonical view safety | 2-3 weeks |
| Aggregation invariants | 2-3 weeks |
| Multi-peer consensus agreement | 3-4 weeks |
| **Total** | **2-4 months** |

The main challenge is fitting properties into the decidable fragment. Weight comparisons involving arithmetic require abstracting away the numbers into an ordering relation, which loses precision. Ivy is at its best for the structural properties (conflicts, inheritance, canonical view consistency) and less natural for quantitative properties (weight vectors, Beta distributions).

### Confidence Gain

**Very high for safety properties.** An Ivy proof holds for all system sizes — not just "5 blocks and 3 peers" but literally any configuration. This is the gold standard for parameterized distributed protocol safety. If Ivy proves "no conflicting blocks in canonical view," that property holds unconditionally.

**Limited for**: Quantitative properties, liveness, anything involving real arithmetic.

### Prior Art

- **Pipelined Moonshot consensus** verified with Ivy (2024) — proved fork-freedom for all network sizes assuming < 1/3 Byzantine validators.
- **Stellar Consensus Protocol** verified with Ivy.
- **Paxos and Raft** variants verified with Ivy.

---

## F\* (F-star)

F\* is a dependently-typed programming language from Microsoft Research and INRIA. Properties are types; proofs are programs. It can extract verified implementations to OCaml, F#, C (via KaRaMeL), or WebAssembly. The DY\* framework provides Dolev-Yao analysis for executable protocol code, bridging Tamarin-style cryptographic reasoning with verified implementations.

### Assumptions

- **Dependent type theory**: The most expressive foundation. Any property that can be stated mathematically can be expressed as a type. The compiler verifies that the code inhabits the type (i.e., satisfies the property).
- **DY\* framework** (optional): Provides Dolev-Yao symbolic adversary model within F\*, combining Tamarin-style security analysis with verified executable code.
- **Computational model** (optional): Can reason about computational assumptions (beyond Dolev-Yao) via refinement types.

### What It Can Prove

Everything the other tools can prove, plus:
- The verified specification and the executable implementation are the **same artifact**. There is no gap between "what was proved" and "what runs."
- Cryptographic properties and protocol properties in the same framework (via DY\*).
- Memory safety, termination, information flow, concurrent correctness (via Steel/PulseCore).

### Code Sample

This shows how F\*'s refinement types encode protocol invariants directly in the type system.

```fstar
module Scaffold.Consensus

open FStar.Seq
open FStar.Classical

type block_hash = nat

// Weight vector: non-empty sequence of non-negative values
type weight_vec = w:seq nat{length w > 0}

// A block with refinement: weight entries are non-negative (enforced by nat)
noeq type block = {
    hash:       block_hash;
    anchor:     block_hash;
    weight:     weight_vec;
    aggregates: list block_hash;
}

// Verified weight: each component <= declared (enforced by type)
type verified_weight (b: block) =
    v:seq nat{
        length v = length b.weight /\
        (forall (i:nat). i < length v ==> index v i <= index b.weight i)
    }

// Sum of weight vector
let rec sum_weight (w: seq nat) : Tot nat (decreases (length w)) =
    if length w = 0 then 0
    else index w 0 + sum_weight (slice w 1 (length w))

// Effective weight: own + descendants
let effective_weight (#b: block) (vw: verified_weight b) (desc: nat) : nat =
    sum_weight vw + desc

// Canonical view: a set where no two elements conflict
// The conflict predicate is a parameter (injected from conflict module)
type canonical_view (conflicts: block_hash -> block_hash -> bool) =
    v:list block_hash{
        forall h1 h2. mem h1 v /\ mem h2 v /\ h1 <> h2
            ==> not (conflicts h1 h2)
    }

// Key theorem: verified weight never exceeds declared weight
let verified_leq_declared (b: block) (vw: verified_weight b)
    : Lemma (sum_weight vw <= sum_weight b.weight) =
    // Proof by induction on vector length
    admit() // Full proof would go here
```

### Effort Estimate

| Task | Time |
|------|------|
| Learning F\* (for a team new to dependent types) | 1-2 months |
| Core data structures + invariants | 1-2 months |
| Consensus algorithm with proofs | 1-2 months |
| Cryptographic layer via DY\* | 2-3 months |
| Extraction to Wasm/OCaml | 1 month |
| **Total** | **6-12 months** |

F\* is the heaviest investment. It is justified if you want a verified reference implementation — not just "the design is correct" but "this specific code is correct." The DY\* framework is the only tool that unifies cryptographic and protocol verification in a single executable artifact.

### Confidence Gain

**Highest possible.** A verified F\* implementation means the code that runs is the code that was proved correct. There is no "we proved the model, but the implementation might differ" gap. However, the effort is 3-5x that of TLA+ or Tamarin.

### Prior Art

- **Project Everest**: Verified TLS 1.3 implementation (miTLS) in F\*.
- **DY\***: Verified Signal protocol, verified MLS TreeSync (USENIX Security 2023).
- **ethereum-star**: F\* proofs of Ethereum properties.

---

## AI-Adversarial Testing

This is a fundamentally different approach: instead of proving properties, you try to break the protocol by giving an AI agent economic incentives and access to a test network.

### Concept

Run a test network of Scaffold nodes in Docker containers. Introduce an adversarial AI agent — an LLM with tool access — in a resource-constrained container. Give it:
- A starting balance.
- API access to create blocks, post collateral, and interact with the network.
- A goal: "Maximize your balance by any means. You may publish invalid blocks, exploit timing, collude with other agents, or do anything the protocol allows."
- A constraint: limited CPU (cannot outcompute the honest network by brute force).

The AI explores the protocol's attack surface through trial and error, guided by its understanding of the protocol documentation.

### Why This Complements Formal Methods

Formal verification proves properties of an **idealized model**. AI-adversarial testing attacks the **actual implementation**. They find different bugs:

| | Formal Verification | AI-Adversarial Testing |
|-|---------------------|----------------------|
| **Finds** | Design flaws, invariant violations | Implementation bugs, economic exploits, unexpected interactions |
| **Misses** | Implementation-specific bugs, economic strategy | Subtle mathematical invariant violations |
| **Guarantees** | Mathematical proof (within model) | None — absence of found bugs doesn't prove safety |
| **Coverage** | Exhaustive within model | Stochastic, guided by AI creativity |

The AI might discover attacks that formal models don't capture: timing-based strategies, gossip manipulation, collateral gaming, or economic strategies that are technically "legal" but extract value in unintended ways.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Test Orchestrator                    │
│  - Spawns nodes, seeds balances, monitors state      │
│  - Checks invariants continuously                    │
│  - Records all blocks for post-mortem analysis       │
└──────────┬──────────────┬──────────────┬────────────┘
           │              │              │
    ┌──────┴──────┐ ┌─────┴─────┐ ┌─────┴──────┐
    │ Honest Node │ │Honest Node│ │Honest Node │
    │  (Docker)   │ │ (Docker)  │ │  (Docker)  │
    │ Full proto  │ │ Full proto│ │ Full proto │
    │ cpu: 2      │ │ cpu: 2    │ │ cpu: 2     │
    └──────┬──────┘ └─────┬─────┘ └─────┬──────┘
           │              │              │
           └──────┬───────┴──────┬───────┘
                  │   P2P mesh   │
           ┌──────┴──────────────┴───────┐
           │       Adversary Agent        │
           │         (Docker)             │
           │                              │
           │  LLM with tool access:       │
           │  - create_block()            │
           │  - post_collateral()         │
           │  - query_utxo_set()          │
           │  - get_canonical_view()      │
           │  - send_block_to_peer()      │
           │                              │
           │  cpu: 0.5 (limited)          │
           │  balance: 1000 (seed)        │
           │  goal: maximize balance      │
           │                              │
           │  Has access to:              │
           │  - Protocol docs (read-only) │
           │  - Network state             │
           │  - Transaction history       │
           └──────────────────────────────┘
```

### What the AI Agent Would Have Access To

**Tools** (callable functions):
- `create_block(anchor, claims, outputs, weight)` — create and publish a block
- `create_invalid_block(...)` — create a block with intentionally wrong computation
- `post_collateral(target, side, amount)` — stake FOR or AGAINST a block
- `query_outputs(filter)` — see available outputs
- `get_canonical_view()` — see current consensus state
- `get_block(hash)` — fetch block details
- `send_to_peer(peer_id, block)` — targeted gossip (selective block release)
- `withhold_block(hash)` — create but don't publish (for late-reveal attacks)
- `get_balance()` — check current balance

**Context** (system prompt):
- The full protocol documentation (docs/protocol/*.md)
- Current network state summary
- History of past actions and their outcomes
- Goal: "Your balance started at 1000. Maximize it. You may use any strategy. You are competing against honest nodes that follow the protocol correctly."

### Attack Strategies the AI Might Discover

Based on the protocol's structure, plausible attack vectors include:

1. **Deception game exploitation**: Publish invalid blocks, hope aggregators don't probe, then self-catch and claim aggregator collateral. The protocol documents this as intended behavior — the AI should discover the equilibrium fraud rate.

2. **Selective withholding**: Create a valid block but withhold it, let others build on an alternative, then release to cause a reorg. Tests the late-reversal attack defense.

3. **Collateral timing**: Post AGAINST collateral on blocks just before the resolution deadline, when the other side can't respond. Tests whether the resolution mechanism handles last-minute stakes.

4. **Weight inflation**: Declare high weight on trivially cheap computations (the "easy trick" attack from weight.md). Tests whether the sampling module catches it.

5. **Gossip manipulation**: Selectively relay blocks to create asymmetric views across the network. Tests gossip convergence properties.

6. **Aggregation rushing**: Aggregate subtrees without probing, gambling that all blocks are valid. Tests whether the risk/reward balance is calibrated correctly.

### Implementation Approach

**Phase 1: Test network infrastructure** (2-3 weeks)
- Docker Compose setup with N honest nodes running the Scaffold protocol
- Orchestrator that seeds initial balances, monitors invariants, and records all blocks
- Chaos injection capabilities: network delays, partitions, node restarts

**Phase 2: Adversary agent** (2-3 weeks)
- LLM agent with tool-use access to protocol operations
- System prompt with protocol docs and goal description
- Action logging for post-mortem analysis
- Multiple agent instances with different system prompts (conservative, aggressive, collusion-focused)

**Phase 3: Campaigns** (ongoing)
- Run multi-hour adversarial sessions
- Vary: number of honest nodes, adversary CPU budget, starting balance, which protocol docs the adversary sees
- Analyze results: did the adversary increase balance? What strategy did it use? Did it find something unexpected?
- Feed discovered attacks back into formal verification (model the attack in TLA+, verify the fix)

### Existing Tools to Build On

- **Attacknet** (Trail of Bits): Kubernetes + Kurtosis orchestration + Chaos Mesh fault injection. Built for Ethereum testing. The architecture could be adapted for Scaffold.
- **Jepsen**: Clojure-based distributed systems testing framework. Injects network partitions, clock skew, process crashes. Has specific Tendermint tests for Byzantine consensus.
- **Chaos Mesh**: Kubernetes-native chaos engineering. Supports network delay/loss/partition, IO faults, clock skew, CPU/memory stress.
- **ChatAFL**: LLM-guided protocol fuzzing (NDSS 2024). Achieved 47.6% more state transitions than baseline fuzzers. Designed for network protocols, not blockchain specifically, but the technique (LLM generates protocol messages, fuzzer mutates them) transfers.

### Effort Estimate

| Phase | Time |
|-------|------|
| Test network infrastructure | 2-3 weeks |
| Adversary agent framework | 2-3 weeks |
| First campaign + analysis | 2-3 weeks |
| Iteration on discovered issues | Ongoing |
| **Total to first results** | **2-3 months** |

### Confidence Gain

**Qualitatively different from formal methods.** AI-adversarial testing does not prove anything — a clean run does not mean the protocol is safe. But it finds bugs that formal models miss:
- Implementation bugs (off-by-one in rebasing, race conditions in gossip)
- Economic imbalances (deception game is too profitable, aggregation risk model is miscalibrated)
- Emergent strategies (the AI discovers an attack nobody thought of)

The most valuable output is not "no bugs found" but the specific attack traces the AI produces. Each trace is either a protocol bug (fix it) or a known-safe strategy (document it and add it to the test suite).

---

## Recommended Approach

These approaches are not mutually exclusive. A practical verification strategy layers them:

### Near-term (1-3 months)

1. **TLA+ for the consensus/conflict core.** Model the consensus module, conflict detection, and canonical view. Check the key safety invariants. This is the highest-value, most actionable step — TLA+ catches protocol design bugs that would be catastrophic in production.

2. **Dafny for algorithmic correctness.** Verify the claim mask operations (bit vector intersection, rebasing, partial knowledge monotonicity) and weight vector derivation. These are pure algorithms where Dafny's verified-implementation approach is a natural fit.

### Medium-term (3-6 months)

3. **Tamarin for spending conditions.** Model the signature, collateral, and timelock contracts. Prove that no adversary can bypass spending conditions. This is important but less urgent — spending conditions are simpler and less likely to have subtle bugs than the consensus mechanism.

4. **AI-adversarial testing infrastructure.** Build the test network and adversary agent. Run initial campaigns. This provides empirical confidence that complements the formal proofs, and may surface economic imbalances that no formal tool can catch.

### Long-term (6-12+ months)

5. **Ivy for parameterized safety** (if the TLA+ results reveal properties that need unbounded proofs).

6. **F\* for verified implementation** (if a verified reference implementation becomes necessary, e.g., for the core consensus algorithm or the WASM verification runtime).

### Emerging

7. **Veil** (CAV 2025): A new framework embedded in Lean 4 that combines model checking, deductive verification, and AI-powered invariant inference for distributed protocols. Still early but potentially the most relevant tool for Scaffold's needs long-term.

---

## Interaction with Protocol Modules

| Verification Approach | Consensus | Conflict | Sampling | Trust | Gossip | Block Creation | Computation |
|----------------------|-----------|----------|----------|-------|--------|---------------|-------------|
| TLA+ | Primary | Primary | Partial | Partial | Partial | Primary | — |
| Tamarin | — | — | — | Primary | — | — | Primary |
| Dafny | Partial | Primary | Primary | — | — | Primary | — |
| Ivy | Primary | Primary | — | — | — | — | — |
| F\* | All | All | All | All | — | All | All |
| AI Testing | All | All | All | All | All | All | All |
