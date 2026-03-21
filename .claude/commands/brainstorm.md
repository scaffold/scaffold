# Brainstorm: Creative Protocol Design

You are helping brainstorm solutions for a protocol design question in Scaffold. The user's question or topic is:

$ARGUMENTS

---

## Instructions

Run a structured brainstorming process designed to produce creative, non-obvious ideas. The goal is ideas like the "aggregation fee = proof of weight" insight -- things that are elegant, simple, and leverage existing mechanisms in unexpected ways.

### What makes good Scaffold ideas

- **Eliminate rather than add.** The best ideas remove mechanisms by showing an existing one already handles the concern.
- **Leverage existing costs.** Every block already pays aggregation fees, posts collateral, and passes through sampling. What can we get "for free" from things already happening?
- **Incentive alignment over enforcement.** Prefer mechanisms where the correct behavior is the profitable behavior, rather than mechanisms that detect and punish misbehavior.
- **Compose with the system.** An idea that works in isolation but breaks when combined with other mechanisms is worthless.
- **Quantify the advantage.** Don't just say "an attacker could exploit this" -- say "the attacker gets Nx advantage at Y cost." Bounded advantages may be acceptable.

### Scaffold Context (for agents)

Include this context in every agent prompt:

```
Scaffold is a browser-first protocol for global consensus via a chain-of-trees DAG.

Core mechanisms:
- Blocks have outputs (value-bearing, with contract verifiers) and claims (consuming
  others' outputs). Refs are read-only references to other outputs.
- Throughput balancing: input value = output value (conservation).
- Conflicts: two blocks claiming the same output conflict; resolved by effective weight.
- Aggregation: subtrees are rolled up by aggregator blocks. Aggregation is a regular
  contract (generator + verifier pair), not a special protocol construct.
- Sampling: clients verify blocks by re-executing contracts. Descent is proportional
  to declared throughput; verification cost is measured and used to scale effective weight.
- Deception equilibrium: publishers pay aggregation fee f ~= v (verification cost) to
  aggregators who post collateral M*C. Strategic self-flagging funds the verification
  layer. See deception.md.
- Weight = verification cost (measured by sampling). The aggregation fee is the
  irreversible proof-of-weight. No whitelist or work formula needed.
- Canonical-independent weight: all descendants count regardless of conflict outcomes.
  This avoids a dependency cycle between weight and canonicality.
- O(log N) weight propagation via balanced aggregation trees.
- Deterministic WASM contract execution.

Key invariants:
- Outputs before claims (extended vector ordering).
- No circular trust (collateral can't be descendant of target).
- Self-claims are net-zero (same contract input and output).

Key insight: the aggregation fee (from deception equilibrium) is already an irreversible
cost proportional to verification cost, making it a natural proof-of-weight that
eliminates the need for whitelists, work formulas, and fee-compression mechanisms.

Protocol docs are in docs/protocol/. Read the ones relevant to the question.
```

---

## Phase 1: Understand the Problem (you, the main agent)

Before launching any subagents:

1. Read the protocol docs relevant to the question. Don't guess -- actually read them.
2. Identify which mechanisms touch this problem.
3. List 3-5 **assumptions** the current design makes about this area.
4. List what costs are **already being paid** that might be leverageable.
5. State the problem in one sentence: "We need X such that Y, but Z makes it hard."

Write this analysis out before proceeding.

---

## Phase 2: Divergent Generation (4 parallel agents)

Launch 4 agents in parallel, each with a different creative lens. Include the Scaffold context above, the relevant doc contents, and your Phase 1 analysis in each prompt.

**Critical instructions for ALL agents:**
- Generate 8-10 ideas each, explicitly including impractical or wild ones.
- Do NOT self-censor. Not every idea needs to work. The goal is to find 1-2 that do.
- Do NOT validate the current design. Your job is to find alternatives.
- For each idea, state: (1) the core insight, (2) what it enables or simplifies, (3) what it breaks or depends on, (4) a one-sentence "elevator pitch."
- Read the relevant protocol docs yourself -- don't rely on summaries.

### Agent 1: The Eliminator

```
Your job is REMOVAL and SIMPLIFICATION. For the problem described below, find
things that can be eliminated because something else already handles them.

Techniques:
- For each mechanism involved, ask: "If I removed this entirely, what breaks?"
- For each thing that breaks, ask: "What is the SIMPLEST thing that fixes it?"
- Ask: "Are any components solving problems CREATED by other components?"
  (This question found the biggest insight in the project so far.)
- Ask: "What costs are already being paid that we're not leveraging?"
- Look for mechanisms doing double duty -- one mechanism serving two purposes.

Do NOT suggest adding new mechanisms. Only suggest removals, unifications,
or leveraging existing things.
```

### Agent 2: The Connector

```
Your job is CROSS-POLLINATION and ANALOGY. Find connections between separate
parts of the system, and import ideas from other fields.

Techniques:
- For each pair of protocol modules, ask: "These both do X. Can they be unified?"
- Apply SCAMPER to each mechanism involved:
  - Substitute: What if we replaced X with Y?
  - Combine: What if mechanism A and mechanism B were the same operation?
  - Adapt: What mechanism from auction theory / insurance / biology could work here?
  - Modify: What if the parameter were 100x larger or smaller?
  - Eliminate: What if this didn't exist?
  - Reverse: What if the roles were swapped?
- Think about analogies from: auction design, insurance markets, biological immune
  systems, error-correcting codes, market microstructure, reputation systems.
- Abstract the problem: what is this problem "really about" at a deeper level?
```

### Agent 3: The Heretic

```
Your job is to CHALLENGE ASSUMPTIONS and EXPLORE FORBIDDEN TERRITORY.

Techniques:
- List every assumption the current design makes about this area.
- For each assumption, propose a design that VIOLATES it. What becomes possible?
- Ask "What if the opposite were true?" for each design principle.
- Apply artificial constraints to force novel solutions:
  - "Solve this with zero on-chain state"
  - "Solve this with only local information"
  - "Solve this without any explicit verification"
  - "Solve this if blocks had no signatures"
- Propose at least 2 ideas that the team would initially reject as "obviously wrong."
  Explain why they might actually work.
- Ask: "What would this look like if it were easy?"
```

### Agent 4: The Adversary

```
Your job is to ATTACK the current design AND every proposed alternative.
You are a well-funded, patient, technically sophisticated attacker.

Techniques:
- For the current approach to this problem, find 3 attack vectors the team hasn't
  considered. Don't recycle attacks from attacks.md -- find NEW ones.
- For each attack, quantify: cost to attacker, benefit if successful, probability
  of detection. Give concrete numbers where possible.
- Think about COMPOSITION attacks: combining two individually-harmless behaviors
  to create a harmful one.
- Think about ECONOMIC attacks: not breaking the protocol, but extracting
  disproportionate value through rational play.
- Think about TEMPORAL attacks: exploiting timing, ordering, or information asymmetry.
- For each attack you find, propose the minimal defense. Can the defense be something
  that already exists in the protocol?
- Think about what a nation-state level adversary would do vs. an opportunistic one.
```

---

## Phase 3: Synthesis (you, the main agent)

After all 4 agents return:

1. **Collect and deduplicate.** List all unique ideas across agents.
2. **Cross-pollinate.** For each pair of interesting ideas, ask: "What if we combined these?" The best insights often come from combining an Eliminator idea with a Heretic idea.
3. **Filter for composability.** For each surviving idea, check: does it compose with the rest of the protocol? Does it break any existing mechanism?
4. **Rank by elegance.** Prefer ideas that eliminate complexity over ideas that add it. An idea that removes two mechanisms and replaces them with nothing is better than one that adds a clever new mechanism.

Select the top 3-5 ideas for stress testing.

---

## Phase 4: Adversarial Stress Test (1-2 sequential agents)

For each of the top ideas, launch an agent with this prompt:

```
You are a game theorist and adversarial analyst. Below is a proposed protocol
mechanism. Your job is to find its fatal flaw, or confirm it's sound.

[Insert the idea, its mechanism, and how it composes with the system]

Instructions:
1. State the STRONGEST objection to this idea (steelman, not strawman).
2. Propose the most devastating attack against it. Quantify the advantage.
3. Check: does this idea create a problem that requires ANOTHER mechanism to
   solve? (If yes, it's probably not elegant enough.)
4. Check: does this idea's defense depend on an assumption that could be false?
5. Give your honest assessment: is this idea (a) sound, (b) promising but needs
   work, or (c) fatally flawed? Be direct.
```

Run 2-3 rounds. If the idea survives the first round with modifications, test the modified version.

---

## Phase 5: Present Results

Present the final ideas to the user, ranked by promise. For each:

1. **The insight** (one sentence -- what's the core realization?)
2. **The mechanism** (how does it work, concretely?)
3. **What it eliminates or simplifies** (the elegance case)
4. **The strongest objection** (from stress testing)
5. **What it depends on** (assumptions, other mechanisms)
6. **Confidence level** (high / medium / speculative)
7. **Next step** (what would you do next to develop this idea?)

Also present any attacks from Agent 4 that don't yet have defenses -- these are valuable even if no solution was found.

---

## Anti-Patterns to Avoid

- **Don't validate the current design.** The point is to find alternatives, not confirm what exists.
- **Don't add complexity.** If your best idea is "add a new module that does X," you probably haven't thought hard enough.
- **Don't be vague.** "Use some kind of reputation system" is not an idea. "Use the sampling success rate as an implicit reputation signal that decays the collateral multiplier M" is an idea.
- **Don't ignore composition.** Every idea must work with the deception equilibrium, throughput balancing, conflict resolution, and sampling. If it doesn't, say so explicitly.
- **Don't consensus-seek across agents.** Disagreement between agents is valuable. Present the disagreement, don't resolve it artificially.
