# Demo: Computation Marketplace

## Overview

Demonstrate Scaffold's core value proposition: a browser posts a computation request, multiple peers race to respond, the first correct response gets paid, and verifiers confirm correctness. This is the "wow" demo -- microtransactions for serverless computation, happening in real-time.

## What Already Works

- **ExecutionModule**: Contract registry mapping Hash -> TypeScript function. Per-claimed-output contract execution. Verifying environment with full context.
- **VerificationModule**: Bridges probing with execution. Coordinates tree selection, probe descent, result recording.
- **GenerationStrategy**: Detects canonical incentive blocks, emits `createBlock` actions.
- **DraftStrategy**: Creates drafts for unclaimed outputs on canonical blocks.
- **FetchManager**: Subscription management for computation results. Multiple fetch modes (fastest, strongest, latest). Notification callbacks.
- **Scaffold.fetch()**: High-level API that subscribes to a verifier and returns results.
- **Scaffold.put()**: Block creation with auto-balancing.
- **ContractGenerator**: Generator execution with coroutine-style resumption (requireInput, requireResult).
- **GeneratingEnv / VerifyingEnv**: Dual-mode contract execution environments.
- **ProbeModule + SamplingStrategy**: Weight verification through statistical sampling.
- **ReactiveLayer**: Full strategy evaluation pipeline.

## What Needs Building

### 1. Demo Contract: String Reversal (or similar)

A simple, understandable contract the audience can follow:

```typescript
// The contract: "reverse this string"
// Input: a block with data containing a UTF-8 string
// Output: a block with data containing the reversed string
// Verification: reversed(reversed(input)) == input AND reversed(input) == claimed_output
```

Why string reversal:
- Trivially verifiable (the audience can check it mentally)
- Non-trivial enough to be a "computation" (not just copying)
- Easy to explain: "I'm paying the network to reverse my string"

Alternatives if string reversal feels too simple:
- **Hash preimage search**: "Find a string whose SHA-256 starts with these bytes" -- more dramatic, but harder to explain
- **Matrix multiplication**: Visually impressive with large matrices, easy to verify (multiply result by inverse)
- **JSON transformation**: More practical, shows real-world applicability

Recommendation: **Start with string reversal, have hash preimage as a stretch goal.**

### 2. Contract Registration

Register the demo contract with the `ExecutionModule`'s contract registry:

```typescript
// Generator mode: produce the reversed string
function generateReverse(env: GeneratingEnv): BlockSpec {
  const input = env.requireResult(requestVerifier);
  const reversed = reverseString(decodeUTF8(input.data));
  return { outputs: [{ verifier: resultVerifier, value: 1, data: encodeUTF8(reversed) }] };
}

// Verifier mode: check the reversal is correct
function verifyReverse(env: VerifyingEnv): boolean {
  const input = env.requireResult(requestVerifier);
  const output = env.getClaimedOutput();
  return reverseString(decodeUTF8(input.data)) === decodeUTF8(output.data);
}
```

The `ExecutionModule` already supports TypeScript contract functions -- no WASM needed for the demo.

### 3. Request Flow

The end-to-end flow:

1. **Client** calls `scaffold.put()` with:
   - An output carrying the request data (the string to reverse)
   - An incentive output (coins payable to whoever computes the result)

2. **Block propagates** via gossip to peer nodes

3. **Generator nodes** detect the incentive output via `DraftStrategy`:
   - `DraftStrategy.evaluate()` sees an unclaimed output matching a registered contract
   - Creates a draft via `DraftManager`
   - `ContractGenerator` runs the contract in generation mode
   - Produces a response block: claims the incentive, outputs the result

4. **Response propagates** back to the client

5. **Client** receives the result via `FetchManager` subscription:
   - `FetchNotifyStrategy` detects the result matches a subscribed verifier
   - `FetchManager` notifies the callback with the canonical result

6. **Verifiers** probe the response via `SamplingStrategy`:
   - `ProbeModule` selects the response block for verification
   - `VerificationModule` runs the contract in verification mode
   - Weight factor updated based on verification result

### 4. Multi-Peer Competition

To show competition:
- Run 3+ generator nodes, all with the contract registered
- All see the request simultaneously
- All produce response blocks
- Consensus determines which response becomes canonical (first to be aggregated with more weight wins)
- The "race" is visible: multiple response blocks appear, one wins

### 5. Verification Display

Show the sampling/probing process:
- After a response is selected, verifiers begin probing
- Show probe descent through the aggregation tree
- Show weight factor increasing as probes succeed
- If a wrong answer were submitted, show the probe failing and weight dropping to 0

### 6. UI

For the demo, show:

**Client view**:
```
Request: "Hello, Scaffold!"
Status: Waiting for response...
Response: "!dloffacS ,olleH" (from node Fox, 120ms)
Verification: 3/3 probes passed, weight factor: 1.0
Payment: 10 coins → Fox
```

**Network view** (if viz is ready):
- Request block appears at client node
- Propagates to all peers
- Response blocks appear at generator nodes
- First response propagates back
- Canonical response highlighted

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Client       │────►│  Generator 1  │     │  Generator 2  │
│  (requests)   │◄────│  (responds)   │     │  (responds)   │
│               │     │               │     │               │
│  fetch()      │     │  DraftStrategy│     │  DraftStrategy│
│  put()        │     │  + contract   │     │  + contract   │
└──────────────┘     └──────────────┘     └──────────────┘
       │                     │                     │
       └─────────────────────┼─────────────────────┘
                             │
                    ┌────────────────┐
                    │  Verifier Node  │
                    │  (samples &     │
                    │   verifies)     │
                    └────────────────┘
```

## Implementation Steps

### Step 1: Demo contract
- New file: `src/demo/ReverseContract.ts`
- Generator function: takes input string, returns reversed string
- Verifier function: checks reversal correctness
- Contract hash: deterministic from contract code identifier
- Register in ExecutionModule's contract registry

### Step 2: Request builder
- New file: `src/demo/ComputationHelper.ts`
- `createRequest(scaffold, inputString, incentiveAmount)`: creates a request block with data output + incentive output
- `subscribeToResult(scaffold, requestVerifier)`: wraps `scaffold.fetch()` with nice callback

### Step 3: Generator node setup
- Extend `DemoNode` (or create `ComputeNode`) to register the reverse contract
- Enable `DraftStrategy` and `GenerationStrategy`
- When an unclaimed incentive output is detected, auto-generate the response

### Step 4: Multi-node scenario
- New file: `src/demo/computation-scenario.ts`
- Spawns 1 client + 3 generators + 1 verifier
- Client posts request
- Generators race to respond
- First response becomes canonical
- Verifier probes and confirms
- Display the full lifecycle with timing

### Step 5: Competition display
- Show all response blocks as they arrive
- Highlight which one won and why (weight, timing)
- Show losing responses becoming non-canonical

### Step 6: Verification display
- Show probe count and results
- Show weight factor evolving
- If time permits: inject a wrong answer and show it being caught

### Step 7: Polish
- Latency measurement (request to response time)
- Comparison framing: "120ms including consensus -- faster than a typical API call"
- `deno task demo:compute` run script

## Stretch Goals

### Hash Preimage Contract
- "Find x such that SHA256(x) starts with 0x00"
- Takes real computation time (adjustable difficulty)
- Makes the "race" more dramatic (generators actually competing on speed)
- Verification is trivial (just hash the answer and check prefix)

### Chained Computation
- Request A depends on request B
- Shows the computation DAG in action
- "Reverse this string, then compute its hash, then find a preimage of that hash"

### Wrong Answer Scenario
- One generator deliberately returns a wrong answer
- Verifier catches it during sampling
- Collateral is slashed (if collateral posting is implemented)
- Shows economic penalty for cheating

## Effort Estimate

- Demo contract: ~0.5 day
- Request builder: ~0.5 day
- Generator node setup: ~1 day (main integration work)
- Multi-node scenario: ~1 day
- Competition + verification display: ~1 day
- Polish: ~1 day
- **Total: ~5 days**

## Dependencies

- Requires `DraftStrategy` and `GenerationStrategy` to work end-to-end with real contracts (currently tested with stubs)
- `ContractGenerator` needs to handle the generate→block flow for the demo contract
- `FetchManager` subscription must fire correctly when canonical result appears
- Does NOT require WASM runtime (TypeScript contracts work for demo)

## Risk

Medium. The reactive pipeline (DraftStrategy → ContractGenerator → block creation) is implemented but only tested with stubs. The end-to-end flow through real contract execution may surface integration issues. The `requireResult` / `requireInput` coroutine model in `ContractGenerator` needs to work with async resolution.

Mitigation: Test the pipeline with the demo contract before building the full scenario. If the reactive pipeline has issues, fall back to manual block construction (still demonstrates the concept, just without automatic generation).
