# Exploration 4: The WASM Interface and Protocol Synthesis

## Direction

Synthesize E1-E3 into a concrete, implementable design. Define the
actual WASM host interface, resolve tensions between explorations,
and work through end-to-end block flows for every use case. This
exploration answers the prompt's direct question: "what would the
block interface look like?"

---

## The Key Insight: Program as Contract

The simplest computation model: **the computation program IS the
contract**. The output's contract hash is the hash of the computation
WASM. Claiming the output requires producing a result that matches
re-execution.

This eliminates the need for separate "computation request" and
"computation result" contract types. There's just one WASM module
per computation type, and it serves as both the program and the
spending condition.

```
Game tick request output:
  contract: GAME_TICK_WASM_HASH    // the program IS the contract
  value: 10                        // bounty
  data: serialized(currentState)   // input to compute
```

To claim this output, a block must produce the correct next state.
The contract re-executes game-tick.wasm on the input and verifies.

---

## The Unified WASM Interface

Every WASM module in Scaffold exports a subset of these functions:

```
REQUIRED (every contract):
  verify()
    Called when a block claims an output with this contract.
    Must call host_accept() or host_reject().

OPTIONAL (computation programs):
  compute(input_ptr, input_len) -> (result_ptr, result_len)
    Execute the computation. Used by responders to generate results.
    If exported, the host auto-generates verify() as:
      "run compute(input), compare to claiming block's result output."

OPTIONAL (explorer — from output-data.md):
  list(data_ptr, data_len, path_ptr, path_len) -> (keys_ptr, keys_len)
  read(data_ptr, data_len, path_ptr, path_len) -> (bytes_ptr, bytes_len)
  type(data_ptr, data_len, path_ptr, path_len) -> type_tag

OPTIONAL (weight — from weight.md):
  weight(input_ptr, input_len) -> u64
    Declare the computational weight for this input.

OPTIONAL (offline state validation):
  validate(root_ptr, root_len, path_ptr, path_len,
           proof_ptr, proof_len) -> bool
    Verify a merkle proof against a committed root.
```

### Auto-Generated verify()

If a WASM module exports `compute()` but not `verify()`, the host
generates a default verify:

```
default_verify():
  input = host_output_data()
  expected_result = compute(input)
  actual_result = host_block_output_data(RESULT_OUTPUT_INDEX)
  if expected_result == actual_result:
    host_accept()
  else:
    host_reject()
```

This means most computation programs only need to export `compute()`.
The verification logic is derived automatically.

Programs that need custom verification (e.g., partial verification,
probabilistic checks) can override by exporting their own `verify()`.

---

## WASM Host Functions

The host runtime provides these imports to WASM modules:

```wasm
;; === Output being claimed ===

;; Read the data field of the output being claimed
(import "host" "output_data"
  (func $output_data (result i32 i32)))       ;; -> ptr, len

;; Read the value of the output being claimed
(import "host" "output_value"
  (func $output_value (result i64)))

;; === Claiming block ===

;; Number of outputs on the claiming block
(import "host" "block_output_count"
  (func $block_output_count (result i32)))

;; Read data from a specific output on the claiming block
(import "host" "block_output_data"
  (func $block_output_data (param i32)        ;; output index
                           (result i32 i32))) ;; -> ptr, len

;; Read the contract hash of a specific output on the claiming block
(import "host" "block_output_contract"
  (func $block_output_contract (param i32)    ;; output index
                               (result i32))) ;; -> ptr (32 bytes)

;; Read the value of a specific output on the claiming block
(import "host" "block_output_value"
  (func $block_output_value (param i32)       ;; output index
                            (result i64)))

;; === Oracle ===

;; Fetch external data. During block creation, this calls out to the
;; network/local state. During verification, this replays from the
;; oracle log. The caller cannot distinguish the two cases.
(import "host" "oracle_fetch"
  (func $oracle_fetch (param i32 i32)         ;; request ptr, len
                      (result i32 i32)))      ;; -> response ptr, len

;; === Verdict ===

(import "host" "accept" (func $accept))
(import "host" "reject" (func $reject))

;; === Memory ===

(import "host" "alloc" (func $alloc (param i32) (result i32)))
```

### Oracle Semantics

`oracle_fetch` is the key primitive from E1. It:

- **During creation**: Makes a real call to retrieve data (from
  local state, the network, or other blocks). The host logs the
  request and response.
- **During verification**: Replays the logged response. The WASM
  program sees the same data in both cases.

This makes the computation deterministically reproducible: same input
+ same oracle responses = same output, guaranteed.

### Oracle Log Placement

E1 left open where the oracle log lives. Resolution:

The oracle log is a **self-claimed output** on the computation block:

```
Block:
  outputs: [
    { contract: P, value: V, data: result },          // result (claimable)
    { contract: ORACLE_LOG, value: 0, data: log },    // oracle log (self-claimed)
    { contract: SIGNATURE, value: fee, data: ... },   // responder fee
    { contract: AGGREGATION, value: agg, data: ... }, // agg incentive
  ]
  claims: [
    1,              // self-claim: oracle log (index 1)
    request_index,  // claim the request output
  ]
```

Self-claiming the oracle log means:
- It's part of the block (included in the hash, verifiable)
- It never enters the UTXO set (no one can "spend" the log)
- Verifiers can read it to replay the computation

For large oracle logs, the data field contains a merkle root of the
log entries. Individual entries are fetchable from the publisher
via the offline state mechanism (E3).

---

## Self-Perpetuating Computation Chains

The "program as contract" model creates a natural pattern: **the
result IS the next request**.

```
Genesis output:
  { contract: GAME_TICK, value: 1000, data: initial_state }

Block 1 claims it, produces:
  { contract: GAME_TICK, value: 990, data: state_after_tick_1 }
  { contract: SIGNATURE, value: 9, data: responder_key }
  { contract: AGGREGATION, value: 1, data: ... }

Block 2 claims Block 1's output, produces:
  { contract: GAME_TICK, value: 980, data: state_after_tick_2 }
  { contract: SIGNATURE, value: 9, data: responder_key }
  { contract: AGGREGATION, value: 1, data: ... }

... and so on
```

Each game tick:
1. Claims the previous state output
2. Computes the next state
3. Produces a new output with the same contract (the next request)
4. Extracts a fee for the responder

The game state output carries value forward, gradually depleting.
External participants can inject new value by claiming and re-creating
with higher value.

### Verification Chain

Each link is independently verifiable:
- Take the input (claimed output's data)
- Run game-tick.wasm(input)
- Check that the result matches the produced output's data
- No need to verify the entire chain — each link is self-contained

### Branching

Multiple responders might claim the same state output, producing
different next-state outputs. These **conflict** (they claim the same
output) and the consensus module resolves them by verified weight.

If the computation is deterministic, all honest responders produce the
same result. The conflict is purely economic (who gets the fee), not
computational (what the result is).

---

## End-to-End Flows

### Flow 1: Game Tick (Deterministic Computation)

**Setup**: game-tick.wasm is deployed. It exports `compute()` and
optionally `list()`, `read()`, `type()` for game state exploration.

```
Step 1: Someone creates the initial game state output.
  Output { contract: GAME_TICK, value: 100, data: initial_state }

Step 2: A responder sees the output, runs the computation.
  result = game_tick_wasm.compute(initial_state)

Step 3: Responder creates a block:
  claims: [initial_state_index]
  outputs: [
    { contract: GAME_TICK, value: 90, data: result },
    { contract: SIGNATURE, value: 9, data: responder_pubkey },
    { contract: AGGREGATION, value: 1, data: agg_data },
  ]

Step 4: Contract verification (by peers):
  game_tick_wasm.verify():
    input = host_output_data()    // initial_state
    expected = compute(input)     // re-execute
    actual = host_block_output_data(0)  // result
    assert expected == actual     // match?
    host_accept()

Step 5: Collateral (separate block):
  FOR collateral with insurance commitment (E2)

Step 6: Aggregation:
  Aggregator probes (re-executes some ticks), aggregates if satisfied
```

### Flow 2: Data Lookup by Hash

**Setup**: No specific WASM program needed. Uses a standard
DATA_LOOKUP contract.

```
Step 1: Requester wants data with hash H.
  Output { contract: DATA_LOOKUP, value: 5, data: H }

Step 2: Provider has the data D where hash(D) == H.
  Provider creates commitment (two-stage, from E1):
    Output { contract: DATA_COMMITMENT, value: 0,
             data: { commitment: HASH(D || secret), secret, targetHash: H } }

Step 3: Requester sees commitment, creates payment:
  Claims commitment output with payment.

Step 4: Provider reveals data:
  Claims payment, produces:
    Output { contract: SIGNATURE, value: 5, data: provider_key }
  With self-claimed output:
    Output { contract: DATA_LOOKUP, value: 0, data: D }
    (self-claimed to carry verification data without UTXO pollution)

Step 5: DATA_LOOKUP contract verifies:
  hash(D) == H AND HASH(D || secret) == commitment
```

Note: DATA_LOOKUP is a standard contract that just checks hash
equality. The two-stage commitment is for MITM protection (E1/E2).

### Flow 3: Structured Data I/O (Compilation)

**Setup**: compiler.wasm exports `compute()`, `list()`, `read()`,
`type()`.

```
Step 1: Source code output exists.
  Output { contract: COMPILER, value: 50,
           data: source_disk_image }

Step 2: Responder compiles.
  result = compiler_wasm.compute(source_disk_image)

Step 3: Responder creates block:
  claims: [source_output_index]
  outputs: [
    { contract: RESULT_EXPLORER, value: 0, data: compiled_image },
    { contract: SIGNATURE, value: 48, data: responder_key },
    { contract: AGGREGATION, value: 2, data: agg_data },
  ]

Step 4: COMPILER contract verifies:
  Re-execute compiler on source, compare to compiled_image.

Step 5: Block explorer inspects the compiled image:
  result_explorer_wasm.list(compiled_image, [])
    → ["bin", "lib", "etc", ...]
  result_explorer_wasm.read(compiled_image, ["bin", "myapp"])
    → <binary contents>
```

The RESULT_EXPLORER contract is a read-only contract (nobody claims
it for spending — it's just there for inspection). Its `list()`,
`read()`, `type()` exports let generic tools browse the filesystem.

### Flow 4: Secret/Offline State (Merkle Tree)

**Setup**: merkle-state.wasm exports `validate()`, `list()`, `read()`,
`type()`.

```
Step 1: Publisher creates block with offline state.
  outputs: [
    { contract: COMMITTED_STATE, value: 0,
      data: { root: merkle_root, schema: MERKLE_STATE_HASH } },
    { contract: AGGREGATION, value: 1, data: agg_data },
  ]

Step 2: Someone queries a specific path (cooperative, E3):
  Output { contract: STATE_QUERY, value: 2,
           data: { target: block_hash, path: ["users", "alice"] } }

Step 3: Publisher responds:
  claims: [query_output_index]
  outputs: [
    { contract: SIGNATURE, value: 2, data: publisher_key },
  ]
  Self-claimed output carrying proof:
    { contract: STATE_RESPONSE, value: 0,
      data: { proof: merkle_proof, leaf: alice_data } }

Step 4: Querier verifies locally:
  merkle_state_wasm.validate(root, ["users", "alice"], proof) == true

Step 5: If verification fails, querier escalates (E3):
  Posts STATE_CHALLENGE with collateral.
  Publisher must respond or be treated as fraudulent.
```

### Flow 5: Computation with Oracle Calls

**Setup**: aggregator.wasm makes oracle calls during execution to
read subtree data.

```
Step 1: Aggregator runs computation.
  During execution, aggregator.wasm calls host_oracle_fetch() to
  read subtree claim masks from their merkle-committed state.

  Oracle log is recorded:
    [
      { request: "subtree/0/claimMask", response: <bits> },
      { request: "subtree/1/claimMask", response: <bits> },
    ]

Step 2: Aggregator creates block:
  outputs: [
    { contract: AGGREGATION, value: ..., data: agg_data },
    { contract: ORACLE_LOG, value: 0, data: oracle_log_hash },
  ]
  claims: [oracle_log_output_index]  // self-claim the log

Step 3: Verification:
  Verifier fetches the oracle log (from publisher or from the
  oracle log output data if small enough).
  Replays aggregator.wasm with the same oracle responses.
  Checks that the aggregation data matches.

Step 4: Oracle response verification (independent, E1):
  Verifier checks each oracle response against its source:
  - "subtree/0/claimMask" → challenge subtree 0's commitment
  - If subtree 0's merkle proof validates → oracle response is correct
```

---

## Resolving Tensions from E1-E3

### Tension 1: E1 "unified mechanics" vs. E3 "separate primitives"

**E1**: Challenges and queries are the same mechanical primitive.
**E3**: They should be separate.

**Resolution**: E3 is right — they're separate. But E1's insight is
also valid at a lower level: both use the same OUTPUT → CLAIM pattern.
The difference is in the CONTRACT (spending conditions), not the
mechanism. So:

- Same low-level mechanism (output → claiming block)
- Different contracts (STATE_CHALLENGE vs STATE_QUERY)
- Different consequences (validity impact vs. pure economics)

### Tension 2: Oracle log size

**E1**: Oracle log might be huge for complex computations.

**Resolution**: Use the offline state commitment pattern from E3.
The oracle log output's data field contains a merkle root of the log.
Individual entries are fetchable via STATE_QUERY. For small logs (< 1KB),
include the log inline. For large logs, commit and serve on demand.

```
if oracle_log.size < INLINE_THRESHOLD:
  output.data = oracle_log          // inline
else:
  output.data = merkle_root(oracle_log)  // committed
  // entries available via STATE_QUERY to the publisher
```

### Tension 3: Insurance commitment scope

**E2**: Insurance commitment covers the "correct result."
**E3**: For offline state, the "correct result" is the merkle root.
**E4 (this)**: With program-as-contract, the result is an output.

**Resolution**: The insurance commitment covers HASH(correct_output_data
|| secret). For computations, this is the result bytes. For offline
state, this is the correct merkle root. For combined blocks, it covers
the hash of ALL verification-relevant outputs concatenated.

### Tension 4: Who generates verify()?

If the program only exports `compute()`, the host auto-generates
`verify()`. But what if the computation has oracle calls? The
auto-generated verify needs to replay the oracle log.

**Resolution**: The auto-generated verify:
1. Reads the oracle log from the self-claimed output
2. Sets up oracle replay mode
3. Runs compute(input) with replayed oracle responses
4. Compares result to the block's result output

The host handles oracle replay transparently. The WASM program
doesn't know whether it's in creation mode or verification mode —
`oracle_fetch` works the same either way.

### Tension 5: Result output identity

How does the contract find the "result output" on the claiming block?

**Resolution**: Convention. The result is the **first output** on the
claiming block whose contract hash matches the computation contract.
For a GAME_TICK computation, the contract looks for the first output
with `contract == GAME_TICK_HASH`.

If no matching output exists → reject.
If matching output exists → compare its data to compute(input).

This convention is simple and unambiguous. The auto-generated verify()
uses it. Custom verify() implementations can use any convention.

---

## The Complete Contract Set

Synthesizing E1-E4, the full set of standard contracts:

```
EXISTING (from contracts.md):
  SIGNATURE_CONTRACT      - owned by a public key
  AGGREGATION_CONTRACT    - claimable by aggregator
  COLLATERAL_CONTRACT     - FOR/AGAINST validity stakes
  TIMELOCK_CONTRACT       - delayed spending

NEW (from explorations):
  ORACLE_LOG              - self-claimed, carries oracle log data
  DATA_LOOKUP             - claimable by providing data matching hash
  DATA_COMMITMENT         - two-stage commitment (MITM protection)
  STATE_QUERY             - bounty for offline state data
  STATE_CHALLENGE         - staked challenge for offline state proof
  STATE_RESPONSE          - self-claimed, carries proof data
  DECEPTION_INSURANCE     - commitment to correct result (on FOR block)

APPLICATION-DEFINED:
  GAME_TICK               - game-specific computation contract
  COMPILER                - compilation contract
  ... any WASM module      - any program can serve as a contract
```

Total new standard contracts: 7 (plus any application-defined ones).

Application contracts are the programs themselves. Game developers
write `game-tick.wasm` and its hash IS the contract. No registration
needed — the WASM code IS the specification.

---

## Development Experience

### Writing a Computation Program

```rust
// game_tick.rs — compiled to game-tick.wasm

#[no_mangle]
pub extern "C" fn compute(input_ptr: *const u8, input_len: usize)
    -> (*const u8, usize)
{
    let state = GameState::deserialize(input_ptr, input_len);
    let next_state = state.tick();
    next_state.serialize()
}

// Optional: expose state for block explorers
#[no_mangle]
pub extern "C" fn list(data_ptr: *const u8, data_len: usize,
                       path_ptr: *const u8, path_len: usize)
    -> (*const u8, usize)
{
    let state = GameState::deserialize(data_ptr, data_len);
    let path = Path::deserialize(path_ptr, path_len);
    state.list_children(path).serialize()
}

#[no_mangle]
pub extern "C" fn read(data_ptr: *const u8, data_len: usize,
                       path_ptr: *const u8, path_len: usize)
    -> (*const u8, usize)
{
    let state = GameState::deserialize(data_ptr, data_len);
    let path = Path::deserialize(path_ptr, path_len);
    state.read_value(path).serialize()
}

// verify() is auto-generated by the host:
// runs compute(input), compares to claiming block's result output
```

### Using a Computation (TypeScript Client)

```typescript
import { scaffold } from '@scaffold/sdk';

// Deploy the game tick program
const GAME_TICK = await scaffold.deployWasm('game-tick.wasm');

// Create the initial game state
const genesis = await scaffold.createOutput({
    contract: GAME_TICK,
    value: 1000,
    data: GameState.initial().serialize(),
});

// Watch for game state updates
scaffold.watch(GAME_TICK, (output) => {
    const state = GameState.deserialize(output.data);
    renderGame(state);
});

// Submit a player action (creates a computation request)
await scaffold.createOutput({
    contract: GAME_TICK,
    value: 10,
    data: GameState.withAction(currentState, myAction).serialize(),
});
```

### Running Computations (Responder Node)

```typescript
import { scaffold } from '@scaffold/sdk';

const GAME_TICK = Hash.fromHex('...');

// Register as a computation provider
scaffold.serve(GAME_TICK, {
    // The framework handles:
    // 1. Watching for unclaimed GAME_TICK outputs
    // 2. Running compute() on each input
    // 3. Creating response blocks with result outputs
    // 4. Creating FOR collateral with insurance commitment
    // 5. Optional deception strategy (configurable)

    deception: {
        enabled: true,
        rate: 'auto',  // calibrate to network fraud rate
    },
});
```

### Querying Offline State

```typescript
// Read a specific path from offline state
const balance = await scaffold.queryOfflineState({
    target: stateBlockHash,
    path: ['accounts', 'alice', 'balance'],
    maxBounty: 5,
});
// Framework publishes STATE_QUERY, waits for response,
// verifies merkle proof, returns data

// Browse offline state (using explorer interface)
const keys = await scaffold.listOfflineState({
    target: stateBlockHash,
    path: ['accounts'],
});
// Returns: ['alice', 'bob', 'charlie', ...]
```

---

## What a Block Looks Like in Practice

### Simple Computation Block (Game Tick)

```
Block {
  anchor: chain_tip
  aggregates: []
  claims: [game_state_output_idx]    // claims the previous state
  outputs: [
    // 0: Next game state (claimable by next tick)
    { contract: GAME_TICK, value: 90, data: next_state_bytes },
    // 1: Responder fee
    { contract: SIGNATURE, value: 9, data: responder_pubkey },
    // 2: Aggregation incentive
    { contract: AGGREGATION, value: 1, data: agg_summary },
  ]
  declaredWeight: 1000    // from GAME_TICK.weight(input)
  creator: responder_pubkey
  signature: ...
}

Separate collateral block:
  outputs: [
    // FOR collateral
    { contract: COLLATERAL, value: 1000,
      data: { target: block_hash, side: "for", path: [] } },
    // Insurance commitment (E2)
    { contract: DECEPTION_INSURANCE, value: 0,
      data: { commitment: HASH(next_state_bytes || secret) } },
  ]
```

### Computation Block with Oracle Calls

```
Block {
  anchor: chain_tip
  aggregates: [subtree_1, subtree_2]
  claims: [
    1,                  // self-claim: oracle log (index 1)
    agg_incentive_1,    // claim subtree 1's aggregation incentive
    agg_incentive_2,    // claim subtree 2's aggregation incentive
  ]
  outputs: [
    // 0: Aggregation summary
    { contract: AGGREGATION, value: 2,
      data: { claimMask: ..., chainWeights: ..., ... } },
    // 1: Oracle log (self-claimed)
    { contract: ORACLE_LOG, value: 0,
      data: oracle_log_bytes_or_merkle_root },
    // 2: Aggregation incentive for this block
    { contract: AGGREGATION, value: 1, data: agg_summary },
    // 3: Aggregator fee
    { contract: SIGNATURE, value: fee, data: aggregator_key },
  ]
  declaredWeight: ...
}
```

### Block with Offline State

```
Block {
  anchor: chain_tip
  claims: [input_output_idx]
  outputs: [
    // 0: Computation result (inline)
    { contract: GAME_TICK, value: 90, data: compact_result },
    // 1: Full state commitment (offline)
    { contract: COMMITTED_STATE, value: 0,
      data: { root: merkle_root, schema: MERKLE_SCHEMA_HASH } },
    // 2: Fee + aggregation outputs...
  ]
  declaredWeight: ...
}
```

The block carries a compact inline result (for the computation chain)
AND an offline state commitment (for detailed queries). The inline
result might be a compressed summary; the offline state contains the
full details.

---

## Open Questions Resolved

| Question (from E1-E3) | Resolution |
|----------------------|-----------|
| Oracle log size | Commit as merkle root if large; inline if small |
| Computation request matching | Gossip module routes by contract hash. Responders subscribe to contract hashes they can serve. |
| Partial computation | Chain of outputs with intermediate states. Each link is independently verifiable. |
| Oracle trust | Oracle responses are verified independently (E1 Level 2). For self-referencing data (own merkle tree), oracle responses are verified against the commitment. |
| Challenge vs query | Separate contracts with different spending conditions (E3). Same underlying mechanism (output → claim). |
| Pending challenges and validity | CHALLENGED = elevated risk, not invalid (E3). Economic pressure via sampling priority and aggregation reluctance. |

## Remaining Open Questions

1. **Contract versioning**: If game-tick.wasm is updated, the hash
   changes, creating a new contract. Existing state outputs use the
   old contract. How do state migrations work? One answer: a migration
   contract that accepts old-contract outputs and produces new-contract
   outputs.

2. **Gas/execution limits**: WASM execution during verification could
   be unbounded. Should there be a gas limit? If so, how does it
   interact with declaredWeight?

3. **Memory model**: The host functions use pointer-based memory
   sharing. What's the WASM memory model? Linear memory with
   host-managed allocation?

4. **Deterministic execution**: WASM is mostly deterministic but
   floating-point operations can vary. Should the protocol require
   integer-only WASM? Or mandate a specific float behavior?

5. **Contract discovery**: How does a user find which contracts exist
   and what they do? A contract registry? Or just social convention
   (published WASM hashes)?

---

## Comparison with Other Explorations

### vs. E1 (Computation-Oracle Model)

E1 proposed many contract types (COMPUTATION_REQUEST, COMPUTATION_RESULT,
etc.). This exploration simplifies: the program IS the contract, so
only one contract type per computation. The oracle log is a self-claimed
output, resolving E1's open question about log placement.

### vs. E2 (Self-Catching Deception Game)

Fully compatible. Insurance commitments go on the FOR collateral block
as specified in E2. The program-as-contract model doesn't affect the
deception game mechanics.

### vs. E3 (Offline State and Challenges)

Fully compatible. COMMITTED_STATE, STATE_CHALLENGE, STATE_QUERY, and
STATE_RESPONSE are separate contracts as E3 recommends. The WASM
interface adds `validate()` as an optional export for offline state
schemas.

### What This Adds

The concrete WASM interface specification — host functions, export
conventions, auto-generated verify(), oracle replay semantics. This is
the implementable layer that the other explorations abstracted over.

---

## Summary

The unified design:

1. **Program as contract**: the computation WASM IS the spending
   condition. Its hash identifies both the program and the contract.
   No separate request/result types needed.

2. **Minimal WASM interface**: programs export `compute()`. The host
   auto-generates `verify()` via re-execution. Optional exports:
   `weight()`, `list()`/`read()`/`type()` (explorer), `validate()`
   (offline state).

3. **Self-perpetuating chains**: computation outputs use the program
   contract, making the result automatically the next request. Game
   state flows through a chain of UTXO claims.

4. **Oracle log as self-claimed output**: carried in the block, never
   enters UTXO set. Inlined if small, merkle-committed if large.

5. **Seven new standard contracts** plus any application-defined
   programs. No block schema changes.

6. **All tensions resolved**: oracle log placement, challenge vs query
   distinction, insurance commitment scope, result output identity.
