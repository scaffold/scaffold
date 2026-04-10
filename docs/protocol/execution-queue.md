# Execution Queue

The execution queue schedules and resource-limits all contract execution -- both verification (re-executing a block's contracts to confirm validity) and generation (running a contract to produce a new block). It is a single global priority queue: verification and generation tasks compete for the same worker pool, ordered by expected profit.

Without an execution queue, nodes run every contract immediately and without resource limits. As contracts move to WASM, this becomes untenable: a malicious or buggy contract could consume unbounded CPU time, and the node has no way to prioritize high-value work over low-value work.

For context on how verification triggers sampling, see [sampling](sampling.md). For contract execution mechanics, see [computation](computation.md). For the economic model that determines cost budgets, see [trust](trust.md) and [deception](deception.md).

---

## Cost Budgets

Every execution task has a **maximum cost** -- a wall-clock time budget in milliseconds. If the execution exceeds this budget, the worker is terminated.

### Verification Budget

The cost budget for verifying a block is derived from the **risk transfer fee** -- the fee an aggregator earns for taking on the risk of a subtree. This fee approximates the verification cost the aggregator incurred:

```
verification_budget_ms = risk_transfer_fee * ms_per_cost_unit
```

Where:
- `risk_transfer_fee = insurance_deposit * (1 - MIN_RETURN_RATE)` -- approximately 5% of the insurance deposit (see [trust](trust.md))
- `ms_per_cost_unit` -- a node-local conversion factor mapping economic value to wall-clock time, calibrated to the node's hardware

The risk transfer fee is the protocol's estimate of what verification should cost. A node that cannot verify a block within this budget is either underpowered for the contract, or the contract is more expensive than the fee suggests.

### Generation Budget

The cost budget for generating a block is derived from the **expected profit** of completing the block:

```
generation_budget_ms = expected_profit * ms_per_cost_unit
```

The expected profit is the throughput surplus the block would produce -- the economic value of creating the block. A node should not spend more time generating a block than the block is worth.

### Node-Local Calibration

The `ms_per_cost_unit` factor is node-local and not part of the protocol. Different nodes have different hardware capabilities. A powerful node converts each unit of economic value to fewer milliseconds (it can do more work per unit of time); a weak node converts to more milliseconds.

This means nodes naturally self-select: a node with slow hardware sets a low `ms_per_cost_unit`, which gives it smaller budgets, causing it to reject expensive contracts and focus on cheap ones. No coordination is needed -- nodes self-limit based on their own capacity.

---

## Too-Expensive Rejection

Before enqueueing a verification task, the node compares the computed budget against its **maximum acceptable cost** -- a node-local threshold for the largest execution it is willing to attempt.

If `verification_budget_ms > max_acceptable_cost_ms`, the verification is **declined**:

1. The sample query has already been counted (via `initSample` in the [sampling module](sampling.md)).
2. No verification is recorded -- the query increments the denominator but not the numerator.
3. The block's weight factor trends toward zero on this node.

This is not litigation. The node is not claiming the block is invalid -- it is saying "I cannot afford to verify this." Other nodes with more resources may verify it successfully. The block's weight factor converges based on whichever nodes can actually afford to run the contract.

The effect: expensive contracts need economic support proportional to their cost. If the risk transfer fee is too low relative to the contract's actual execution cost, most nodes will decline verification, and the block's weight factor will remain low. This creates market pressure to set fees that match actual verification costs.

---

## Termination

When a running task exceeds its wall-clock budget, the worker is terminated:

### Verification Termination

A terminated verification is recorded as a **failed sample**:

- `recordVerification(terminalHash, false)` is called, same as a contract rejection.
- The weight factor decreases (more queries, same verified count).
- **No litigation is initiated.** The node does not challenge the block or post an AGAINST bond. Other peers with more resources or better hardware may verify the block successfully. The node simply treats the result as "I couldn't verify this" rather than "this is fraudulent."

This distinction matters: a timeout reflects the node's resource limits, not the block's validity. Initiating litigation based on a timeout would be incorrect -- the block may be perfectly valid, just too expensive for this node to verify within its budget.

### Generation Termination

A terminated generation **cancels the draft**:

- The in-progress block draft is discarded.
- The generation slot is freed for other work.
- The node may retry later if conditions change (e.g., higher expected profit justifies a larger budget).

---

## Priority

All tasks compete in a single priority queue. Priority represents the **expected profit of completing the execution** -- how much value the node gains from finishing this task.

### Verification Priority

Verification priority is the expected weight swing from [sampling](sampling.md):

```
priority = swing(T)                                            [no conflict]
priority = swing(T) * contested_weight / max(gap, epsilon)    [in conflict]
```

This is the same formula the sampling module uses for `selectNext()`. It represents: "how much could the canonical set change from one verification?" High-priority targets are unknown trees (few samples), contested conflicts (small gap, large stakes), and high-incentive trees.

### Generation Priority

Generation priority is the expected profit from creating the block:

```
priority = expected_profit
```

Approximated by the draft's `declaredWeight` or expected throughput surplus. A generation task that would produce a high-weight block in a contested conflict has high priority.

### Unified Comparison

Both priorities are in weight-change units, so they are directly comparable. A generation task with `declaredWeight = 100` competes against a verification task whose swing might be ~17 (for a fresh tree with `I = 100`, swing = `I/6`). The generation task wins, which is correct -- creating a profitable block is typically more urgent than one statistical sample of an existing tree.

### Dynamic Re-Prioritization

Priorities change as conditions evolve:

- **Weight changes**: A verification completes, shifting the weight landscape.
- **New blocks**: New conflicts or canonicality changes affect swing calculations.
- **Conflict resolution**: A conflict gap widens, reducing priority for both sides.

The queue periodically re-evaluates all pending task priorities and re-sorts. Running tasks are not re-prioritized (they are already consuming resources), but the queue may optionally cancel a running task whose priority has dropped to zero (e.g., the tree became non-canonical).

---

## Concurrency

The queue maintains a fixed-size **worker pool**. When a task completes (success, termination, or cancellation), the queue dispatches the next highest-priority pending task.

The pool size is node-configurable (`max_workers`, default 4). This is a node-level resource allocation decision, not a protocol parameter.

### Interaction with Sampling Backpressure

The [sampling module](sampling.md#pending-backpressure) already provides natural concurrency limiting: each pending sample inflates the query count, reducing the swing and making additional samples on the same tree less attractive. The execution queue's worker pool provides a hard limit on top of this soft limit.

---

## Interaction with Other Modules

| Module | Interaction |
|--------|-------------|
| [Sampling](sampling.md) | Provides verification priority via `getPriority()`. Receives verification results via `recordVerification()`. Provides sample descent via `initSample()`. |
| [Computation](computation.md) | The execution queue wraps contract execution. `ExecutionModule.verifyBlock()` is called by the queue, not directly. |
| [Trust](trust.md) | Provides the risk transfer fee used to compute verification budgets. Insurance deposit determines the economic value of verification. |
| [Deception](deception.md) | The fee/cost relationship emerges from the deception equilibrium: `fee ~= v` where `v` is the true verification cost. |
| [Consensus](consensus.md) | Weight changes from completed verifications trigger re-prioritization. |
| [Block Creation](block-creation.md) | Generation tasks produce new blocks. Draft manager enqueues generation work through the queue. |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/ExecutionQueueModule.ts`](../../src/core/ExecutionQueueModule.ts) | Generic priority queue with worker pool and wall-clock timeouts. Agnostic to what it runs. |
| [`src/core/ExecutionQueueService.ts`](../../src/core/ExecutionQueueService.ts) | Protocol-specific layer: `enqueueVerification()` and `enqueueGeneration()` construct `Executable` objects with the right priority, budget, and completion callbacks. |
