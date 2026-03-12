# Exploration 8: Contract Versioning, State Migration, and Cross-Contract Composition

## Direction

E4's "program as contract" model ties the computation WASM hash to the
contract identity. This means changing the program changes the contract.
An output with contract = GAME_V1_HASH can only be claimed by running
GAME_V1_WASM. If the game upgrades to V2, the hash changes, and existing
state outputs become unclaimable by V2. This exploration analyzes the
versioning problem, proposes solutions, and also examines how different
computation contracts compose — calling each other, consuming each
other's outputs, and building higher-level protocols.

---

## The Versioning Problem

### Why It's Fundamental

In traditional systems, you deploy a new version of your code and it
runs against the same database. State persists across code changes.

In program-as-contract, the code IS the contract. State is locked to
the code version:

```
Game V1 chain:
  state_0(V1) → state_1(V1) → state_2(V1) → state_3(V1)
                                                  ↑
                                            current UTXO

Developer deploys Game V2.  V2_HASH ≠ V1_HASH.

state_3(V1) cannot be claimed by V2 — the contract doesn't match.
```

The chain is dead-ended. V2 can start fresh, but all state accumulated
in V1 is lost (or at least stranded).

### Why Not Just Use the Same Hash?

If V2 is backward-compatible, could you use the same hash? No — ANY
change to the WASM binary changes the hash. Even adding a comment
(if WASM had comments) or fixing a minor bug produces a different hash.
The hash is the identity. There is no "same contract, different code."

---

## Solution 1: Migration Contracts

### Concept

A **migration contract** is a one-time computation that consumes V1
state and produces V2 state:

```
Migration WASM (M_HASH):
  compute():
    v1_state = block_output_data(0)  // read V1 output
    v2_state = migrate(v1_state)     // transform
    output_data(v2_state)            // write V2 output
    accept()
```

The migration block:
```
claims: [state_3(V1)]     // consumes the V1 UTXO
outputs: [
  { contract: V2_HASH, data: v2_state },   // V2 chain starts here
  ...
]
```

### How It Works

1. Developer writes V2 WASM with the new game logic.
2. Developer writes a migration WASM that knows how to transform V1
   state into V2 state.
3. Someone publishes a block running the migration, consuming the last
   V1 state and producing the first V2 state.
4. The V2 chain continues from the migrated state.

### Who Can Run the Migration?

The migration WASM is itself a contract. The V1 output's spending
condition determines who can claim it. There are two options:

**Option A: V1 contract allows migration claims.**

V1's WASM must recognize migration blocks and accept them. This means
V1 must have been designed with upgradeability in mind:

```
V1 compute():
  input = block_output_data(0)
  // Check if this is a normal game tick or a migration
  if claiming_contract == KNOWN_MIGRATION_HASH:
    // Delegate to migration contract verification
    accept()
  else:
    result = game_tick(input)
    output_data(result)
    accept()
```

**Problem**: V1 would need to know V2's migration hash in advance,
which is impossible. Or V1 would need a generic "migration allowed"
flag, which would let anyone claim the output with arbitrary
migration logic.

**Option B: Multi-contract spending condition.**

The V1 output uses a more flexible contract — not GAME_V1_HASH directly,
but a wrapper that allows claims from either V1 game ticks or authorized
migrations:

```
GAME_WRAPPER contract:
  compute():
    claimer_contract = ... // identify what contract the claimer is using
    if claimer_contract == V1_HASH:
      // normal game tick
      verify_game_tick()
    elif claimer_contract in AUTHORIZED_MIGRATIONS:
      // migration
      verify_migration()
    else:
      reject()
```

**Problem**: How does GAME_WRAPPER know which migrations are authorized?
This requires governance — someone decides which migrations are valid.

**Option C: The output uses a DIFFERENT contract from the program.**

Separate the "spending condition" from the "computation program." The
output uses a governance contract that accepts claims from approved
program versions:

```
Output:
  contract: GAME_GOVERNANCE_HASH
  data: { state: ..., approved_versions: [V1_HASH, V2_HASH, ...] }
```

But this BREAKS program-as-contract. The whole elegance of E4 was that
the program hash IS the contract. Adding a governance layer recreates
the complexity E4 eliminated.

### Preferred Approach: Explicit Migration Blocks

Don't try to make V1 outputs claimable by V2. Instead:

1. V1's contract includes a `migrate_to(target_hash)` path that
   produces an output with a DIFFERENT contract hash.
2. V1 must be designed to support this from the start.
3. The migration path in V1 validates that the new state is a valid
   transformation of the old state (or delegates validation to the
   migration WASM).

```
V1 compute():
  input = block_output_data(0)

  // Check for migration flag in the claiming block's outputs
  result_output = first_output_with_contract(V1_HASH)
  if result_output exists:
    // Normal tick
    result = game_tick(input)
    output_data(result)
    accept()
  else:
    // Migration: the claimer is producing output with a different
    // contract hash. V1 doesn't validate the new state — it just
    // allows the old state to be consumed.
    // The new contract's verification handles correctness.
    accept()
```

Wait — this is too permissive. V1 just accepts any claim that doesn't
produce a V1 output? That allows arbitrary theft of the V1 UTXO.

### Actually Preferred: Migration as Protocol Convention

The cleanest approach separates migration into two steps:

**Step 1**: The V1 chain produces a "final" output marked as
migrateable. The V1 contract includes a `finalize()` mode that produces
an output with a generic MIGRATION_READY contract.

```
V1 compute():
  mode = detect_mode()
  if mode == TICK:
    // normal game tick
    ...
  elif mode == FINALIZE:
    // Produce migration-ready output
    output_data(current_state)           // same state
    output_contract(MIGRATION_READY)     // generic migration contract
    accept()
```

**Step 2**: Any migration WASM can claim MIGRATION_READY outputs. The
MIGRATION_READY contract is simple:

```
MIGRATION_READY compute():
  // Accept any valid computation that consumes this state
  // The claimer's output contract determines the new chain
  accept()
```

**Step 3**: A migration block claims the MIGRATION_READY output,
transforms the state, and produces a V2 output.

This is clean but requires V1 to have been designed with a FINALIZE
mode. If V1 wasn't designed this way, its state is permanently locked.

### The Immutability Tradeoff

This is actually correct and desirable behavior. In a system where code
IS the contract, changing the code is a big deal. You SHOULD have to
plan for upgrades. The analogy to Ethereum smart contracts is apt:
unupgradeable contracts are a feature, not a bug, because they provide
guarantees that the rules won't change. If you want upgradeability, you
build it in explicitly.

**Recommendation**: Computation contracts SHOULD include a migration
path if the developer anticipates upgrades. The protocol should provide
a standard MIGRATION_READY contract for this purpose. Contracts without
a migration path are permanently locked to their current version — this
is by design.

---

## Solution 2: Proxy Contracts (Indirection Layer)

### Concept

Instead of using the computation WASM hash directly as the contract,
use a proxy contract that delegates to a versioned implementation:

```
GAME_PROXY contract:
  compute():
    // Look up the current implementation version
    version_hash = read_governance_output()
    // Delegate to the versioned implementation
    result = delegate_compute(version_hash, input)
    output_data(result)
    accept()
```

### Why This Doesn't Work

1. **Verification becomes non-deterministic**: Different verifiers might
   see different governance outputs (which version is current) and
   disagree on which implementation to run. The oracle log could fix
   this, but E5 deferred oracle logs.

2. **Breaks program-as-contract**: The proxy is a fixed contract, but
   the actual computation varies. The hash of the proxy doesn't identify
   the computation. Two blocks with the same proxy contract might run
   completely different programs.

3. **Trust implications**: The proxy contract's correctness depends on
   the governance output, which is itself a block that could be
   fraudulent. This creates a chain of trust that the deception game
   wasn't designed for.

**Conclusion**: Proxy contracts add complexity without clear benefit
over explicit migration. Reject this approach.

---

## Solution 3: Version-Aware Contracts

### Concept

A single WASM binary that handles multiple state versions internally:

```
GAME_MULTI compute():
  state = block_output_data(0)
  version = detect_version(state)

  if version == 1:
    result = game_tick_v1(state)
  elif version == 2:
    result = game_tick_v2(state)
  else:
    reject()

  output_data(tag_version(result, CURRENT_VERSION))
  accept()
```

### Tradeoffs

**Pro**: Single contract hash, no migration blocks needed. State
naturally migrates as it flows through the chain.

**Con**: The WASM binary grows with every version. Old code is carried
forever. Bug fixes require a new WASM binary (new hash), which is a
new contract — you're back to the same problem.

**Con**: Every bug fix or feature requires deploying a new WASM that
includes ALL old versions plus the new one. The hash changes every
time. This doesn't actually solve versioning; it just delays it.

**Conclusion**: Version-aware contracts work for planned, backward-
compatible changes (adding a field to state) but not for fundamental
logic changes or bug fixes. Not a general solution.

---

## Recommended Versioning Strategy

### Design-Time Decision

Contract developers must choose their upgradeability stance:

1. **Immutable**: No migration path. The contract is permanent.
   Appropriate for simple, well-tested contracts (signature checks,
   basic escrow).

2. **Migrateable**: Includes a FINALIZE mode that produces a
   MIGRATION_READY output. The developer can deploy new versions and
   migrate state. Appropriate for evolving applications (games, complex
   protocols).

3. **Version-aware**: Handles multiple state versions internally.
   Appropriate for minor, backward-compatible upgrades within a single
   contract generation.

### Protocol Support

The protocol provides:

1. **MIGRATION_READY standard contract**: A simple contract that
   accepts any valid computation claim. Used as an intermediate step
   in migration flows.

2. **Migration block convention**: A migration block claims a
   MIGRATION_READY output and produces an output with the new contract
   hash. The migration computation is verified like any other computation
   — re-execute the migration WASM and check the output.

3. **No governance mechanism**: The protocol does not decide which
   migrations are valid. The migration WASM defines the transformation,
   and its correctness is verified by re-execution. If the migration
   WASM is wrong, the deception game catches it (or challenges do, for
   offline state).

---

## Cross-Contract Composition

### The Problem

Real applications involve multiple contracts interacting. A game might
need:
- Game state computation (GAME_TICK contract)
- Random number generation (RANDOMNESS contract)
- Player balance management (SIGNATURE contract)
- Price feed (ORACLE_FEED contract)

How do these compose?

### Composition Through Multi-Input Claims

E7 introduced multi-input computation (game ticks consuming player
moves + previous state). This generalizes to cross-contract composition:

```
Game tick block:
  claims: [
    game_state(GAME_TICK),     // previous game state
    player_move(SIGNATURE),     // player's move (signed)
    randomness(RANDOMNESS),     // random seed
  ]
  outputs: [
    next_state(GAME_TICK),     // new game state
    player_balance(SIGNATURE), // updated balance
  ]
```

Each claimed output has its OWN contract (spending condition). The
claiming block must satisfy ALL of them. This means the game tick WASM
must:

1. Be recognized by GAME_TICK as a valid claimer (it produces a
   GAME_TICK output → same contract chain).
2. Be recognized by SIGNATURE as a valid claimer (it includes the
   player's signature).
3. Be recognized by RANDOMNESS as a valid claimer (it meets the
   randomness contract's conditions).

### The Verification Question

When a verifier re-executes the game tick WASM, they verify that the
computation is correct given the inputs. But who verifies that each
input's spending condition was met?

**Each contract verifies independently.** The claiming block runs
multiple contracts:
- GAME_TICK.verify() checks the game computation.
- SIGNATURE.verify() checks the player's signature.
- RANDOMNESS.verify() checks the randomness claim.

All must pass for the block to be valid. This is already how the
protocol works — claiming multiple outputs means satisfying multiple
spending conditions.

### Composition Through Output Chaining

Contracts can also compose through output chains — one contract's
output is consumed by another:

```
Block 1 (RANDOMNESS):
  outputs: [{ contract: RANDOMNESS, data: random_seed }]

Block 2 (GAME_TICK):
  claims: [random_seed(RANDOMNESS), game_state(GAME_TICK)]
  outputs: [{ contract: GAME_TICK, data: next_state }]
```

The game tick claims the randomness output, using it as an input. The
RANDOMNESS contract's spending condition governs who can claim the
random seed and under what conditions.

### Internal Contract Calls (Not Supported)

What about a game tick WASM that wants to CALL another WASM internally?

```
GAME_TICK compute():
  state = block_output_data(0)
  random = RANDOMNESS.generate()  // ← calling another contract
  new_state = tick(state, random)
  output_data(new_state)
  accept()
```

This is NOT supported in the program-as-contract model, and for good
reason:

1. **Determinism**: Which RANDOMNESS implementation? The hash must be
   specified, but internal calls create implicit dependencies that
   aren't captured in the block structure.

2. **Gas accounting**: Whose gas budget covers the internal call? The
   caller's? Separate budgets? This is the EVM's re-entrancy problem.

3. **Verification**: The verifier needs to re-execute the internal call
   too, which means they need the internal contract's WASM, which
   means they need to know about it, which means it should be an
   explicit input.

**Design principle**: All cross-contract interaction happens through
explicit outputs and claims. No internal calls. This keeps the
execution model simple and the dependencies visible.

### Composition Patterns

#### Pattern 1: Sequential Pipeline

```
Raw Data → Preprocessor → Analyzer → Result
```

Each step is a separate contract. The output of one is the input of
the next. This creates a computation chain spanning multiple contracts.

```
Block 1: claims [raw_data], outputs [preprocessed(PREPROCESSOR)]
Block 2: claims [preprocessed(PREPROCESSOR)], outputs [analyzed(ANALYZER)]
Block 3: claims [analyzed(ANALYZER)], outputs [result(RESULT)]
```

Each block runs a different contract. Each can be published by a
different node.

#### Pattern 2: Fan-In Aggregation

```
Source A ↘
Source B → Combiner → Result
Source C ↗
```

Multiple outputs from different contracts are consumed by a single
block:

```
Block: claims [source_a(A), source_b(B), source_c(C)]
       outputs [result(COMBINER)]
```

The COMBINER contract verifies that sources A, B, C were correctly
combined.

#### Pattern 3: Fan-Out Distribution

```
Source → Distributor → Target A
                     → Target B
                     → Target C
```

One block produces multiple outputs with different contracts:

```
Block: claims [source(SOURCE)]
       outputs [
         target_a(CONTRACT_A),
         target_b(CONTRACT_B),
         target_c(CONTRACT_C),
       ]
```

The SOURCE contract verifies that the distribution is correct.

#### Pattern 4: Bidirectional Communication

Two computation chains that exchange data periodically:

```
Chain A: state_A0 → state_A1 → state_A2 → ...
Chain B: state_B0 → state_B1 → state_B2 → ...

At step 2:
Block: claims [state_A1(A), state_B1(B)]
       outputs [state_A2(A), state_B2(B)]
```

A synchronization block claims from both chains and advances both.
This is how two games could interact (e.g., a marketplace game that
reads prices from an economic simulation game).

---

## Contract Identity vs. Program Identity

### The Tension

Program-as-contract says: hash of WASM = contract = identity. But
users think of "the game" as a persistent thing with a stable identity,
not a specific WASM binary.

### Application-Level Identity

The protocol doesn't need to solve this. Application-level tooling
can maintain a registry:

```
Game Registry:
  "Chess" → [
    { version: 1, hash: V1_HASH, status: "deprecated" },
    { version: 2, hash: V2_HASH, status: "active" },
    { version: 3, hash: V3_HASH, status: "beta" },
  ]
```

This registry is itself data on the network (published as blocks),
not a protocol mechanism. Users and explorers use it to discover the
current version of a game.

### Contract Namespacing

Contracts could embed metadata in their WASM:

```
// Exported constants
const NAME = "Chess";
const VERSION = 3;
const AUTHOR = "alice_pubkey";
const PREVIOUS_VERSION = V2_HASH;
```

The block explorer reads these exports to display human-readable
contract information. The protocol doesn't use them — they're
informational.

---

## Impact on the Design

### What Changes

- **New standard contract**: MIGRATION_READY, a simple contract for
  intermediate migration state. Semantics: accept any valid computation
  claim. Very simple WASM.

- **Contract design guidance**: Developers should include a FINALIZE
  mode if they want upgradeability. This is a convention, not a
  protocol rule.

- **Multi-input verification**: Clarify that claiming multiple outputs
  requires satisfying all their spending conditions independently.
  This is already implicit in the protocol but not stated explicitly
  in the context of computation contracts.

### What Doesn't Change

- **Program-as-contract**: Still the core model. The WASM hash IS the
  contract identity. No proxy layer, no governance mechanism.

- **Block schema**: No changes. Migration blocks are regular blocks
  that claim one contract's output and produce another contract's output.

- **Deception game**: Unchanged. Migration computations are verified
  the same way as any other computation.

- **UTXO model**: Unchanged. Migration is just a claim from one
  contract to another.

---

## Comparison with E1-E7

### vs. E4 (WASM Interface)

E4 introduced program-as-contract without addressing versioning. This
exploration validates that program-as-contract works with versioning
through explicit migration paths, but requires developers to plan for
upgradeability. The model's immutability is a feature, not a limitation.

### vs. E5 (Critical Review)

E5 listed "contract versioning" as a risk but didn't analyze it. This
exploration resolves the risk: migration through FINALIZE +
MIGRATION_READY is clean, requires no protocol changes, and preserves
program-as-contract's simplicity.

### vs. E7 (Weight/Gas)

E7 introduced multi-input computation for sustainability. This
exploration generalizes it to cross-contract composition: a block
claiming outputs from multiple different contracts, with each
contract's spending condition verified independently.

### vs. Ethereum

Ethereum uses proxy patterns (EIP-1967) for upgradeability, with all
the complexity and vulnerabilities they entail (storage collisions,
delegatecall risks, governance attacks). Scaffold's approach is simpler:
explicit migration with a new contract, no proxy layer, no shared
storage. The tradeoff is that migration is more manual and state is
explicitly transformed rather than implicitly carried over.

---

## Summary

1. **Contract versioning is solvable** without breaking program-as-
   contract. Developers include a FINALIZE mode in upgradeable
   contracts that produces MIGRATION_READY outputs. Migration blocks
   transform state from old to new contract versions.

2. **Immutability is a feature.** Contracts without migration paths
   are permanently locked. This provides strong guarantees about
   rule stability. Upgradeability is opt-in.

3. **Cross-contract composition works through multi-input claims.**
   A block claiming outputs from multiple contracts satisfies all
   spending conditions independently. No internal contract calls —
   all dependencies are explicit in the block structure.

4. **No protocol changes needed.** Migration is a convention (FINALIZE
   mode + MIGRATION_READY contract), not a protocol mechanism.
   Cross-contract composition is already supported by the UTXO model.

5. **Application-level identity** (contract registries, metadata
   exports) maps human-readable names to contract hashes. The
   protocol doesn't need a naming system.

6. **Four composition patterns** cover the common cases: sequential
   pipeline, fan-in aggregation, fan-out distribution, and
   bidirectional communication between chains.
