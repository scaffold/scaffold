# Exploration 9: The Developer Experience and SDK Design

## Direction

The prompt asks "what would be the development experience?" Previous
explorations designed the protocol mechanics but didn't examine what it
feels like to build on them. This exploration walks through the end-to-
end developer workflow: writing a computation contract, testing it
locally, deploying it, interacting with it, debugging failures, and
integrating with the block explorer. The goal is to identify what SDK
and tooling the protocol needs to make development practical.

---

## Writing a Computation Contract

### The Simplest Contract: Counter

A counter that increments a number. The state is a single integer.

```rust
// counter.rs — compiles to counter.wasm

use scaffold_sdk::prelude::*;

#[scaffold_compute]
fn compute(ctx: &ComputeContext) -> Result<()> {
    // Read the previous state from the claimed output
    let prev: u64 = ctx.input_data(0)?
        .map(|bytes| u64::from_le_bytes(bytes.try_into().unwrap()))
        .unwrap_or(0);  // genesis: start at 0

    // Compute next state
    let next = prev + 1;

    // Write the result output (same contract → self-perpetuating chain)
    ctx.output(next.to_le_bytes())?;

    ctx.accept()
}

// Optional: explorer integration
#[scaffold_explorer]
fn read(data: &[u8], path: &[&str]) -> ExplorerResult {
    match path {
        [] => ExplorerResult::Number(u64::from_le_bytes(data.try_into()?)),
        _ => ExplorerResult::NotFound,
    }
}
```

What the `#[scaffold_compute]` macro generates:

1. A WASM `compute` export that reads inputs from the host, calls the
   user's function, writes outputs via host functions, and calls
   accept/reject.
2. A `verify` export (auto-generated): re-runs `compute` with the same
   inputs and compares the output to the block's declared output.
3. Boilerplate for host function bindings (output_data, block_output_
   data, accept, reject).

### A Game Tick Contract

```rust
// game.rs — a simple 2D game tick

use scaffold_sdk::prelude::*;

#[derive(Serialize, Deserialize)]
struct GameState {
    entities: Vec<Entity>,
    tick: u64,
    rng_seed: u64,
}

#[derive(Serialize, Deserialize)]
struct PlayerMove {
    player_id: u64,
    action: Action,
}

#[scaffold_compute]
fn compute(ctx: &ComputeContext) -> Result<()> {
    // Input 0: previous game state (from GAME contract)
    let mut state: GameState = ctx.input_data(0)?
        .map(|b| deserialize(b))
        .unwrap_or_else(GameState::initial);

    // Inputs 1..N: player moves (from SIGNATURE contracts)
    let moves: Vec<PlayerMove> = (1..ctx.input_count())
        .filter_map(|i| ctx.input_data(i).ok().flatten())
        .map(|b| deserialize(&b))
        .collect();

    // Simulate one tick
    state.tick += 1;
    state.rng_seed = hash(state.rng_seed, state.tick);
    for m in &moves {
        apply_move(&mut state, m);
    }
    simulate_physics(&mut state);
    resolve_collisions(&mut state);

    // Output: next game state (same contract)
    ctx.output(serialize(&state))?;

    ctx.accept()
}

#[scaffold_explorer]
fn explore(data: &[u8], path: &[&str]) -> ExplorerResult {
    let state: GameState = deserialize(data);
    match path {
        [] => ExplorerResult::Map(vec!["tick", "entities", "rng_seed"]),
        ["tick"] => ExplorerResult::Number(state.tick),
        ["entities"] => ExplorerResult::List(state.entities.len()),
        ["entities", i] => {
            let idx: usize = i.parse()?;
            ExplorerResult::Map(vec!["x", "y", "type", "hp"])
        }
        ["entities", i, field] => {
            let idx: usize = i.parse()?;
            let e = &state.entities[idx];
            match *field {
                "x" => ExplorerResult::Number(e.x as u64),
                "y" => ExplorerResult::Number(e.y as u64),
                "type" => ExplorerResult::String(e.entity_type.name()),
                "hp" => ExplorerResult::Number(e.hp as u64),
                _ => ExplorerResult::NotFound,
            }
        }
        _ => ExplorerResult::NotFound,
    }
}
```

### What the Developer Doesn't Write

- **Verification logic**: Auto-generated. The host re-runs `compute()`
  with the same inputs and compares.
- **Insurance commitments**: Handled by the SDK/runtime. The publisher's
  node automatically generates `HASH(result || secret)` on the FOR
  collateral block.
- **Gas accounting**: Handled by the WASM runtime. The developer doesn't
  think about gas unless they hit the limit.
- **Collateral posting**: Handled by the node software. When publishing a
  computation result, the node automatically creates a collateral block.
- **Block structure**: The SDK translates `ctx.output()` calls into the
  block's output array. The developer works with data, not block
  mechanics.

---

## The SDK Architecture

### Layers

```
┌─────────────────────────────────────┐
│  Developer's Contract Code (Rust)   │  ← what you write
├─────────────────────────────────────┤
│  scaffold_sdk (Rust crate)          │  ← macros, types, host bindings
├─────────────────────────────────────┤
│  WASM Binary (.wasm)                │  ← compiled output
├─────────────────────────────────────┤
│  Scaffold Runtime (TypeScript)      │  ← executes WASM in browser/node
├─────────────────────────────────────┤
│  Protocol Modules                   │  ← consensus, trust, sampling...
└─────────────────────────────────────┘
```

### scaffold_sdk Crate

The Rust crate provides:

```rust
// Core trait — the developer implements this
pub trait ComputeContract {
    fn compute(ctx: &ComputeContext) -> Result<()>;
}

// Context object — access to inputs and outputs
pub struct ComputeContext { ... }
impl ComputeContext {
    fn input_count(&self) -> usize;
    fn input_data(&self, index: usize) -> Result<Option<Vec<u8>>>;
    fn input_value(&self, index: usize) -> Result<u64>;
    fn output(&self, data: impl AsRef<[u8]>) -> Result<()>;
    fn output_with_value(&self, data: impl AsRef<[u8]>, value: u64) -> Result<()>;
    fn accept(&self) -> Result<()>;
    fn reject(&self) -> Result<()>;
}

// Explorer trait — optional
pub trait ExplorerContract {
    fn list(data: &[u8], path: &[&str]) -> Vec<String>;
    fn read(data: &[u8], path: &[&str]) -> ExplorerResult;
    fn type_of(data: &[u8], path: &[&str]) -> DataType;
}

// Serialization helpers
pub fn serialize<T: Serialize>(value: &T) -> Vec<u8>;
pub fn deserialize<T: DeserializeOwned>(bytes: &[u8]) -> T;
```

### Language Support

The primary SDK is Rust (best WASM toolchain). But the WASM interface
is language-agnostic. Other languages that compile to WASM can be
supported with thin bindings:

- **AssemblyScript** (TypeScript → WASM): Good for web developers.
  Lower performance but familiar syntax.
- **C/C++** (via Emscripten): For computation-heavy contracts.
- **Go** (via TinyGo): Possible but WASM support is less mature.

The protocol specifies the WASM export interface, not the source
language. The SDK is a convenience, not a requirement.

### WASM Export Interface

What the compiled WASM must export (language-agnostic):

```
Required:
  compute(input_ptr, input_len) -> (output_ptr, output_len)

Optional:
  weight() -> u64
  list(data_ptr, data_len, path_ptr, path_len) -> (keys_ptr, keys_len)
  read(data_ptr, data_len, path_ptr, path_len) -> (value_ptr, value_len)
  type(data_ptr, data_len, path_ptr, path_len) -> u32

Optional (for offline state):
  validate(root_ptr, root_len, path_ptr, path_len, proof_ptr, proof_len) -> bool

Optional (for migration):
  finalize(state_ptr, state_len) -> (migration_ptr, migration_len)
```

Host functions the WASM can import:

```
  output_data(ptr, len) -> void
  block_output_data(index) -> (ptr, len)
  accept() -> void
  reject() -> void
```

---

## Local Development Workflow

### Step 1: Create Project

```bash
scaffold new my-game
cd my-game
```

Generates:
```
my-game/
├── src/
│   └── lib.rs          # contract code
├── tests/
│   └── basic.rs        # local tests
├── Cargo.toml          # rust dependencies
└── scaffold.toml       # project config
```

`scaffold.toml`:
```toml
[contract]
name = "my-game"
version = "1.0.0"

[build]
target = "wasm32-unknown-unknown"
optimize = true         # wasm-opt for smaller binary

[test]
initial_state = "tests/fixtures/initial_state.bin"
```

### Step 2: Write and Build

```bash
scaffold build
```

Compiles to WASM, runs wasm-opt, outputs:
```
target/scaffold/my-game.wasm      # the contract binary
target/scaffold/my-game.hash      # SHA-256 of the WASM (= contract hash)
```

### Step 3: Test Locally

```rust
// tests/basic.rs
use scaffold_test::*;

#[test]
fn test_counter_increment() {
    let contract = load_contract("target/scaffold/counter.wasm");

    // Create initial state
    let state_0 = 0u64.to_le_bytes();

    // Run one tick
    let result = contract.compute(&[&state_0]);
    assert_eq!(result.outputs[0].data, 1u64.to_le_bytes());

    // Run another tick
    let result2 = contract.compute(&[&result.outputs[0].data]);
    assert_eq!(result2.outputs[0].data, 2u64.to_le_bytes());
}

#[test]
fn test_game_with_moves() {
    let contract = load_contract("target/scaffold/my-game.wasm");

    let initial = GameState::initial();
    let move1 = PlayerMove { player_id: 1, action: Action::MoveLeft };

    let result = contract.compute(&[
        &serialize(&initial),
        &serialize(&move1),
    ]);

    let new_state: GameState = deserialize(&result.outputs[0].data);
    assert_eq!(new_state.tick, 1);
    // ... more assertions
}

#[test]
fn test_verification_catches_fraud() {
    let contract = load_contract("target/scaffold/my-game.wasm");

    let state = serialize(&GameState::initial());
    let correct_result = contract.compute(&[&state]);

    // Tamper with the result
    let mut tampered = correct_result.outputs[0].data.clone();
    tampered[0] ^= 0xFF;

    // Verification should fail
    let verified = contract.verify(&[&state], &tampered);
    assert!(!verified);
}
```

The test runner executes WASM locally with a mock host. No network, no
blocks, no collateral — just pure computation testing.

```bash
scaffold test
```

### Step 4: Interactive Testing

```bash
scaffold playground
```

Opens a local web UI where you can:
- Load a contract
- Provide inputs manually or from fixtures
- Step through computation
- Inspect outputs through the explorer interface
- Visualize state changes across multiple ticks

### Step 5: Local Network Testing

```bash
scaffold devnet --nodes 3
```

Starts a local network with 3 simulated peers. You can:
- Publish computation requests
- Watch responders claim and compute
- See collateral posting and aggregation
- Trigger deception (publish wrong results) and watch verification
- Inspect the block graph in a local explorer

---

## Deployment and Interaction

### Deploying a Contract

"Deployment" in Scaffold is just publishing the first block that uses
the contract. There's no deployment transaction — the WASM binary is
identified by hash and distributed through gossip.

```bash
scaffold publish --contract target/scaffold/my-game.wasm \
                 --initial-state tests/fixtures/initial_state.bin \
                 --bounty 10
```

This creates a block with:
```
outputs: [{
    contract: SHA256(my-game.wasm),
    value: 10,
    data: <initial_state>
}]
```

The WASM binary is attached to the block (or served on demand). Peers
who want to compute the next tick fetch the WASM and execute it.

### Contract Discovery

Peers learn about contracts through:

1. **Gossip**: Blocks referencing a contract hash are gossiped. Peers
   interested in that contract request the WASM binary.
2. **Registry**: Application-level registries (E8) map names to hashes.
3. **Direct sharing**: Developer shares the contract hash and WASM
   binary out-of-band.

### Interacting with a Running Game

```bash
# Submit a player move
scaffold move --game <contract_hash> \
              --action '{"player_id": 1, "action": "move_left"}' \
              --value 1

# Watch game state
scaffold watch --contract <contract_hash>

# Query game state through explorer
scaffold explore --block <block_hash> --path "entities/0/hp"
```

The `scaffold move` command creates a block with:
```
outputs: [{
    contract: SIGNATURE_CONTRACT,
    value: 1,
    data: <serialized_move>
}]
```

The game tick responder claims both the previous state output and the
player move output, computing the next state.

---

## Debugging

### When Computation Fails Verification

The most common developer issue: the contract produces different results
on different machines. This breaks verification (the verifier gets a
different output than the publisher).

**Common causes**:
1. **Floating-point non-determinism**: Different WASM runtimes may
   produce different floating-point results.
2. **Uninitialized memory**: Reading memory before writing it.
3. **HashMap iteration order**: Non-deterministic in many languages.
4. **System calls**: Anything that depends on the environment.

**SDK mitigations**:
- **No floating-point**: The SDK provides fixed-point math libraries.
  `scaffold_sdk::math::Fixed` replaces `f32`/`f64` for deterministic
  arithmetic. The build system can optionally lint for float usage.
- **Deterministic allocator**: The SDK's memory allocator zeroes
  memory on allocation.
- **Deterministic collections**: `scaffold_sdk::BTreeMap` instead of
  `HashMap`. The SDK re-exports deterministic alternatives.
- **No system access**: The WASM sandbox provides no access to clocks,
  random number generators, or filesystem. All external data comes
  through host functions.

### Debug Tooling

```bash
# Compare local execution against a published block
scaffold verify --block <block_hash> --verbose

Output:
  Input 0: 256 bytes (hash: abc123...)
  Input 1: 64 bytes (hash: def456...)
  Execution: 2,847,391 instructions (28.4% of gas budget)
  Output 0: 260 bytes (hash: fed789...)
  Result: MATCH ✓

# If mismatch:
  Output 0: 260 bytes (hash: fed789...)
  Expected: 260 bytes (hash: 111222...)
  First difference at byte 47
  Local value:    0x3F800000 (float: 1.0)
  Expected value: 0x3F7FFFFF (float: 0.99999994)
  LIKELY CAUSE: floating-point non-determinism
```

```bash
# Profile gas usage
scaffold profile --contract target/scaffold/my-game.wasm \
                 --input tests/fixtures/state.bin

Output:
  Total instructions: 8,234,100
  Breakdown:
    game_tick():        3,200,000 (38.9%)
    simulate_physics(): 2,100,000 (25.5%)
    serialize():        1,500,000 (18.2%)
    deserialize():      1,200,000 (14.6%)
    other:                234,100 ( 2.8%)

  Gas budget at weight 10: 10,000,000
  Utilization: 82.3%
  Headroom: 1,765,900 instructions
```

### Verifying Insurance Commitments

```bash
# Check that a block has a valid insurance commitment
scaffold inspect-insurance --block <block_hash>

Output:
  Insurance commitment found on FOR collateral block <hash>
  Commitment: HASH(result || secret) = abc123...
  Status: commitment present, secret not yet revealed
```

---

## Block Explorer Integration

### How It Works

The block explorer uses the contract-as-explorer interface (output-
data.md) to render computation results:

```
Block #12345 (hash: abc...)
├── Contract: my-game (SHA256: def...)
├── Weight: 10 (gas used: 8.2M / 10M)
├── Inputs:
│   ├── [0] Game State (from block #12344)
│   └── [1] Player Move (from block #12340)
├── Outputs:
│   └── [0] Game State
│       ├── tick: 42
│       ├── entities: (3 items)
│       │   ├── [0] { x: 100, y: 200, type: "player", hp: 80 }
│       │   ├── [1] { x: 150, y: 180, type: "enemy", hp: 50 }
│       │   └── [2] { x: 300, y: 100, type: "item", hp: 0 }
│       └── rng_seed: 0x7F3A...
└── Verification: ✓ (sampled 3 times, all passed)
```

The explorer calls `list()`, `read()`, and `type()` recursively on
the output data, rendering it as a navigable tree. This works for ANY
contract that exports the explorer interface, with zero contract-
specific UI code.

### Rich Visualizations

For contracts that want more than a tree view, the explorer can support
custom renderers:

```rust
#[scaffold_explorer]
fn render_hint() -> &'static str {
    "2d-grid"  // tells the explorer to use a 2D grid renderer
}
```

The explorer ships with built-in renderers for common patterns:
- `tree` (default): recursive key-value tree
- `2d-grid`: renders entities on a 2D canvas
- `table`: tabular data
- `hex`: raw hex dump

Custom renderers can be loaded from the contract WASM itself
(a `render()` export that produces HTML/SVG/Canvas commands).

---

## Development Lifecycle Summary

```
1. scaffold new my-game              # create project
2. Write compute() in Rust           # the actual logic
3. scaffold build                    # compile to WASM
4. scaffold test                     # local unit tests
5. scaffold playground               # interactive testing
6. scaffold devnet                   # multi-node testing
7. scaffold publish                  # deploy to network
8. scaffold watch                    # monitor live state
9. scaffold explore                  # inspect outputs
10. (later) scaffold migrate         # upgrade to v2
```

Each step is self-contained. Steps 1-5 require no network. Step 6
simulates a network locally. Steps 7+ interact with the live network.

---

## What the SDK Must Provide

### Minimum Viable SDK

For Phase 1 (program-as-contract):
1. **scaffold_sdk crate**: ComputeContext, host bindings, macros
2. **scaffold build**: Compile Rust → WASM with wasm-opt
3. **scaffold test**: Local WASM execution with mock host
4. **scaffold publish**: Create initial block with contract output

### Phase 2 Additions (Chains)

5. **scaffold watch**: Monitor computation chain state
6. **scaffold move**: Submit inputs to a running computation chain

### Phase 3 Additions (Deception Game)

7. **scaffold inspect-insurance**: Check insurance commitments
8. **scaffold devnet --deception**: Test with simulated fraud

### Phase 4 Additions (Offline State)

9. **scaffold challenge**: Issue a challenge to a block
10. **scaffold_sdk validate() support**: Merkle proof validation

### Phase 5 Additions (Explorer)

11. **scaffold explore**: CLI explorer using list/read/type
12. **scaffold playground**: Web-based interactive explorer

---

## Comparison with E1-E8

### vs. E4 (WASM Interface)

E4 defined the WASM host interface abstractly (output_data,
block_output_data, accept, reject). This exploration shows what that
looks like from the developer's side: the `ComputeContext` API, the
`#[scaffold_compute]` macro, and the build toolchain. E4's interface
is minimal enough that the SDK stays thin.

### vs. E5 (Prototype Phases)

E5 proposed 5 prototype phases. This exploration shows what developer
tooling each phase needs, confirming that the phases are independently
useful from the developer's perspective too. Phase 1 is immediately
useful: write, build, test, publish.

### vs. E7 (Weight/Gas)

E7 defined gas mechanics. This exploration shows how developers
interact with gas: they don't think about it unless they hit the limit.
The `scaffold profile` command shows gas usage breakdown, helping
developers optimize within their budget.

### vs. E8 (Versioning)

E8 defined migration through FINALIZE + MIGRATION_READY. This
exploration shows the developer workflow: `scaffold migrate` as a CLI
command that handles the migration block creation.

### vs. Ethereum/Solidity DX

Ethereum's developer experience: Solidity → Hardhat/Foundry → deploy
transaction → ABI → ethers.js → Etherscan. Scaffold's equivalent:
Rust → scaffold build → publish block → explorer interface → scaffold
CLI. The main difference: no ABI layer (the explorer interface replaces
it for inspection), no deployment transaction (just publish a block),
and no separate verification (re-execution IS verification).

---

## Summary

1. **The SDK is thin.** The core is a Rust crate with ComputeContext,
   host bindings, and a macro. The WASM export interface is simple
   enough that other languages can target it directly.

2. **Determinism is the developer's main concern.** No floats, no
   HashMaps, no system calls. The SDK provides deterministic
   alternatives (fixed-point math, BTreeMap, zeroed allocator).

3. **Testing is local-first.** Unit tests run WASM with a mock host.
   No network needed. Integration testing uses a local devnet.

4. **The explorer interface is powerful.** Contracts export list/read/
   type, and the explorer renders any contract's data as a navigable
   tree. Rich renderers (2D grid, table) are available for contracts
   that need them.

5. **Gas is invisible until you hit it.** Developers don't think about
   gas during normal development. The profiler shows usage when
   optimization is needed.

6. **The development lifecycle matches the prototype phases.** Each
   phase adds SDK capabilities, and each phase is independently useful.
