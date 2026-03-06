# Weight Derivation (Design Discussion)

This document discusses how block weight is determined — specifically, how the `declaredWeight` field relates to the weight vector, and how `declaredWeight` might eventually be verified or constrained. The weight vector's role in consensus is specified in the [consensus module](consensus.md); this document focuses on where the numbers come from.

---

## Current Design

Each block has a `declaredWeight` field representing the work the block itself contributes. The **weight vector** is structurally derived:

- For a leaf block (no subtrees): `weight = [declaredWeight, 0, 0, ...]`
- For an aggregation block: the weight vector is computed from the subtrees' weight vectors plus their `declaredWeight`, attributed to the correct anchor chain depths.

The weight vector is **structural** — it is deterministically derivable from the block's subtrees and their `declaredWeight` values. The structural verification module can check that a block's weight vector is correctly computed from its components.

What the structural verification module does NOT check (yet) is whether `declaredWeight` itself is honest.

---

## The Problem

`declaredWeight` is currently trusted. A block can claim any weight it wants. The sampling module (via the consensus module) will verify the block's *computation* through spot-checking, but a correct computation with an inflated weight declaration will pass all checks.

### The "Easy Trick" Attack

The pathological case: a contract that is computationally hard in general, but easy if you know a shortcut.

1. Attacker discovers a shortcut for contract C.
2. Attacker publishes many blocks satisfying C, each declaring high weight.
3. The computations are correct — spot-checking passes.
4. The attacker accumulates consensus weight cheaply.
5. The attacker can now win conflicts against honest blocks, shifting canonical state.

The attack is self-limiting once the shortcut is publicly discovered (everyone can use it, deflating the weight's meaning). The danger window is between private discovery and public adoption.

---

## Options for Constraining `declaredWeight`

### Option A: Contract-Declared Weight Functions

Each contract (identified by hash) includes a weight function that computes the expected weight from the block's inputs and outputs.

```
weight_function(block) → Number
```

Structural verification runs the weight function and checks that `declaredWeight <= weight_function(block)`.

**Pros:**
- Deterministic and verifiable — the weight function is part of the contract's WASM.
- Contract authors define the computational cost of their own contracts.
- No global registry needed — the function is embedded in the contract code.

**Cons:**
- Vulnerable to the easy-trick attack: if the computation has a shortcut, the result is correct and the weight function still returns "hard." The weight function measures the *intended* difficulty, not the *actual* difficulty for a particular solver.
- Weight function itself could be manipulated by a malicious contract author.
- Requires running WASM to derive weight — moves weight derivation from structural to contractual verification.

### Option B: Economic Throughput

Weight = f(input values, output values). Since blocks conserve value (sum of inputs = sum of outputs), weight could be the throughput value.

```
declaredWeight = sum(input_values)   // or equivalently sum(output_values)
```

**Pros:**
- Unfakeable — you need real economic value flowing through. Can't inflate weight without risking real capital.
- Pure structural verification — computable from the block's inputs and outputs without running contract WASM.
- Immune to the easy-trick attack entirely (shortcuts don't reduce economic cost).

**Cons:**
- Computation-heavy but low-value blocks (game state transitions) get proportionally low weight. A complex game move might be worth very little economically.
- Vulnerable to wash trading: an attacker cycles value through self-transfers to accumulate weight cheaply. The value is real, the transfers are valid, they just don't accomplish anything useful.
- Conflates economic activity with consensus influence. Rich entities dominate.

### Option C: Collateral-Based Weight

Weight = collateral staked on the block's validity. More skin in the game = more consensus influence.

```
declaredWeight = collateral_staked_for(block)
```

**Pros:**
- Directly ties consensus influence to economic risk.
- Self-regulating: staking more means losing more if wrong.

**Cons:**
- Collateral must be in a separate block (see trust module), so the weight isn't known at block creation time — it evolves as collateral is posted. This complicates the consensus module's weight model.
- Wealthy entities dominate (proof-of-stake dynamics).
- Circular dependency: weight determines consensus → consensus determines which collateral is canonical → canonical collateral determines weight.

### Option D: Hybrid — Economic Base + Declared Supplement

```
declaredWeight = economic_throughput + contract_computational_supplement
```

The economic base is unfakeable and structurally verifiable. The computational supplement is declared and subject to sampling/verification, but bounded by a multiplier of the economic base.

```
constraint: contract_computational_supplement <= K × economic_throughput
```

**Pros:**
- Economic base provides a floor that can't be gamed.
- Computational supplement allows computation-heavy blocks to receive appropriate weight.
- The multiplier K bounds the trick attack: even with a shortcut, the attacker's weight is bounded by K× their economic throughput.

**Cons:**
- More complex. Two sources of weight with different trust properties.
- K is a protocol parameter that needs tuning.
- Still partially vulnerable to the trick attack on the supplement portion.

### Option E: Execution-Time Verification

The verification module not only checks correctness but also measures execution time. If declared weight is disproportionate to observed execution time, the block is flagged.

**Pros:**
- Directly measures what we care about (computational cost).

**Cons:**
- Execution time varies by hardware — no objective standard.
- Attacker could intentionally slow execution to appear expensive.
- Hard to normalize across different environments (browser vs. server, different architectures).

---

## Recommendation

No single option is clearly dominant. The current approach — `declaredWeight` as a trusted field, verified later — is a reasonable starting point. It allows the protocol to proceed with consensus mechanics while the weight verification question remains open.

The most promising long-term directions seem to be:
- **Option A** (contract weight functions) for well-understood contracts with known computational costs.
- **Option B** (economic throughput) as a baseline that's immune to computational tricks.
- **Option D** (hybrid) combining both if we need to capture computational work beyond economic value.

The choice depends on what the dominant block types turn out to be. If most blocks are economic transactions (transfers, payments, escrow), Option B is natural. If most blocks are computation-heavy (game state, data processing), Option A or D is needed.

---

## Interaction with Other Modules

**Consensus module**: Consumes the weight vector. Indifferent to how `declaredWeight` is derived — it just uses the numbers.

**Sampling module**: Currently samples based on declared work. If `declaredWeight` is derived from contracts, the sampling module would sample contract executions. If derived from economic throughput, there's nothing to sample for weight (though computation correctness is still sampled).

**Structural verification module**: Checks that the weight vector is correctly computed from subtrees and `declaredWeight`. May additionally check `declaredWeight` against a derivation rule (economic throughput, contract weight function, etc.) once one is chosen.

**Trust module**: Collateral incentivizes honest weight declaration (if weight is declared rather than derived). Inflated weight that fails verification results in collateral loss.

---

## Implementation

Weight derivation is an open design question. Current implementation uses trusted `declaredWeight`.

| File | Description |
|------|-------------|
| [`src/core/BlockCreationModule.ts`](../../src/core/BlockCreationModule.ts) | Weight vector derivation from `declaredWeight` and subtrees |
| [`src/core/ConsensusModule.ts`](../../src/core/ConsensusModule.ts) | Verified vs declared weight, effective weight computation |
