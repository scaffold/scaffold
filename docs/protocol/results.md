# Results: Answers, Messages, and Fetch

> Status: design direction chosen, partially implemented. The **uniqueness
> rule** (below) is deferred. The **claim-vs-fetch two-model split** at the end
> is exploratory and deliberately low-finality -- do not build load-bearing
> structure on it yet.

## Context

Scaffold is switching from a **record-based** result model to a **data-based**
one.

Under the old model, running a contract produced *records*: outputs under
`RECORD_CONTRACT` whose `params` was a key and whose `data` was the value.
Fetching a verifier `V` meant: find a block claiming `V`, then look inside that
block's record outputs for the one keyed by some agreed-upon key. The result
lived at one level of indirection away from the question it answered, and the
key was a side-channel both sides had to agree on (the [fetch default-key
footgun](../../TODO.md)).

Under the new model, the answer to a verifier is carried *directly* by an
output claimed under that verifier:

> A claimed output `{ contract, params, data }` asserts that `data` is **the
> answer** to the question `{ contract, params }`.

`fetch({ contract, params })` returns `data`. There is no key, no record
namespace hop, no indirection. The verifier is both the question and the index.

### Why this is the right shape

The verifier appears twice -- once on the block that posts the incentive for
`V`, and once on the block that answers `V`. That duplication was the reason we
*didn't* do this first. It turns out to be the feature, not the cost:

- **Answers are self-describing.** A block carrying `{V, data}` declares what
  question it answers without anyone resolving its claims into the ancestor
  chain. A peer holding the block -- but not its full causal history -- can
  still serve and relay the answer. For a browser-first protocol this is a
  structural advantage the record model could not offer.
- **`fetch` becomes referentially transparent.** This is the deep payoff. With
  the [uniqueness rule](#the-uniqueness-rule-deferred), every block answering
  `V` carries byte-identical `data`, so `fetch(V)` is a *function*, not a
  relation -- every reader gets the same bytes regardless of which block they
  found. A deterministic computation can only be built on a function. This is
  what licenses passing data between contracts via `fetch` at all.
- **Self-indexing.** The piggyback inverted index ("which verifiers does this
  trusted block serve?") is read straight off the block's outputs instead of
  resolved through its claims.

The cost we accept: params (the question) are duplicated on the wire. They are
almost always small -- a hash, a key, a short query -- so the trade is good.

---

## The three kinds of data-bearing output

Every output may carry a `data` payload (see
[output-data.md](output-data.md) and
[computation.md#data-less-outputs](computation.md#data-less-outputs)). What an
output *means* is determined by **whether it is claimed** and **whether it
carries data**:

| Kind | Shape | Claimed? | Trusted as | Created by |
|------|-------|----------|-----------|-----------|
| **Incentive** | `{V}` value, no data | unclaimed (until answered) | its value (a bounty for V) | anyone, via `send` / a put incentive |
| **Message / vote** | `{V, data}` | unclaimed | nothing -- untrusted | anyone, via `send` |
| **Answer** | `{V, data}`, value 0 | **self-claimed** | its `data` (the answer to V) | only by running `V`'s contract |

The load-bearing distinction is **answer vs message**, and it turns entirely on
the self-claim:

- A **message** is an unclaimed data-bearing output. Anyone can `send` one under
  any verifier. Nothing validated it, so nothing should trust its `data`. Votes
  (e.g. collateral FOR/AGAINST postings) are messages: a resolver reads them via
  `claimAll` and adjudicates; it does not trust any single one as an answer.
- An **answer** is a *self-claimed* data-bearing output. To self-claim `{V, data}`
  the block must satisfy `V` -- i.e. run `V.contract.run()` with `V.params`,
  which validates `data`. **The self-claim is the validation trigger.** That is
  why an answer is trusted and a message is not: an answer is validated by
  construction, a message never ran its contract.

### Why there is no `ALLOWED_PRODUCERS` policy

An earlier exploration proposed a per-namespace producer ACL to stop a block
forging state by raw-emitting `{V, forged_state}`. The self-claim mechanism
subsumes it:

- `fetch` returns only **answers** (self-claimed). The forge path (`send`)
  produces a **message** (unclaimed), which `fetch` ignores.
- To produce a real answer you must pass `V.run()`. Whether that is forgeable is
  entirely `V`'s own design choice: a contract whose answer is *computed*
  (`state = reduce(prev, move)`) pins `data` and cannot be forged; a contract
  that only checks `requireSignature(player)` lets exactly that signer answer,
  which is correct.

So the producer question dissolves into "does `V.run()` validate the data" --
which lives inside the contract, where it is most expressive. Trust comes from
*was it claimed (hence validated)*, not from *who produced it*. No protocol-level
ACL is needed.

---

## Producing and reading answers

The `ContractEnv` surface (see
[`src/core/ContractEnv.ts`](../../src/core/ContractEnv.ts)) splits into methods
that produce/read answers and methods that move value.

### `setResult(data: Uint8Array): void`

The contract *computes* the answer. Adds a self-claimed output `{V, data}` where
`V` is the running verifier (own `contract` + `params`). In verification it
checks such an output exists with that exact `data`.

This is the answer-producing analogue of `add_output`: the contract fully
specifies the bytes. Use it when the answer is a pure function of the contract's
inputs.

`setResult`, not `addResult`. Multiplicity (a verifier with several answers)
falls out of the existing positional namespace rule -- two `setResult` calls
produce two answer outputs matched positionally -- so a multi-valued variant is
not needed until a real contract demands it (YAGNI). Until then, a second
`setResult` for the same verifier is a candidate to reject.

### `getResult(): MaybePromise<Uint8Array>`

The *host* supplies the answer; `getResult` **commits** it as a self-claimed
`{V, data}` answer and returns the bytes to the contract for validation. This is
the answer-producing analogue of `get_output`: the contract names nothing, the
host provides the data.

> `getResult` commits. It is not a read-only input channel. A contract that
> calls `getResult()` and validates the bytes (e.g. `HashContract` checking
> `hash(getResult()) == params`) has thereby published the answer; that is what
> makes the preimage `fetch`-able afterward.

Where the data comes from, in order:

1. The `data` supplied in a `put(V, data)` context (the put's payload).
2. Otherwise, piggybacking: copy a prior answer's `data` from an already-trusted
   block serving `V`.
3. Otherwise, block until a piggybackable block for `V` is ingested (the same
   parking behavior as a blocked `claimNext`).

`setResult` vs `getResult` is exactly the "contract computes it" vs "host
provides it" duality, specialized to the contract's own verifier.

### `fetch(verifier): Uint8Array`

Returns the `data` of an answer (self-claimed output) for `verifier`, appending
the answering block to `refs`. Because answers are validated-by-construction and
(under uniqueness) byte-identical, `fetch` is the safe, referentially-transparent
way to pass data between contracts.

`fetch`'s long-standing "which block, if several answer V?" ambiguity becomes
*harmless* under the uniqueness rule: all answers agree, so the choice doesn't
matter. That harmlessness is precisely what makes `fetch` usable as an
inter-contract data channel rather than just a best-effort lookup.

### `put(verifier, data): Hash`

Publishes `data` as the answer to `verifier` on a new sub-block (which
self-claims `{verifier, data}`, validated by running `verifier`'s contract with
`data` available via `getResult`), and returns the sub-block's hash. The
read/write duality is now clean:

```
fetch(verifier)        -> Uint8Array   // read the answer
put(verifier, data)    -> Hash         // write the answer, return block hash
```

A player move enters the system this way: the UI calls `put(playerMove(V), move)`;
the move's contract runs (`requireSignature(player)`), `getResult` commits the
move as the answer; later a tick reads it via `fetch(playerMove(V))`.

### `send(verifier, value, data?)`

Emits an *unclaimed* output -- an incentive (data-less) or a message (data-ful).
Untrusted by definition; not returned by `fetch`. This is how bounties and votes
are posted.

---

## The `claimNext` invariant

`claimNext` / `claimAll` are the value side, and they are distinct from the
answer side:

- **`claimNext` consumes an external, value-bearing, data-bearing input**:
  `isSelfClaim == false` and `value > 0`. It is how a contract gathers value
  (a baton being threaded, a bond being aggregated) or reads a value-bearing
  input's data.
- **Answer outputs are zero-value self-claims**: `isSelfClaim == true`,
  `value == 0`, produced by `setResult` / `getResult`.

The `isSelfClaim` / `value` split is what keeps the two from being confused and
what prevents value-minting: you cannot manufacture value by copying another
output's data, because value only ever enters via a `claimNext` over a genuine
external UTXO. Piggyback copies *data* and re-earns an *existing* incentive; it
never mints.

A consequence worth stating, because it makes the purity analysis below clean:
**a pure answer-producer does not call `claimNext` to get paid.** The incentive
`{V}` is *data-less*, so `findInputs` filters it out -- the contract never sees
it. The block-creation layer claims the incentive structurally (throughput
balancing), and the same per-verifier `run()` that validates the `setResult`
answer authorizes that incentive claim (both are under `V`). The contract just
produces the answer; the builder attaches the payment.

---

## The uniqueness rule (deferred)

> Deferred. A nice-to-have, not yet implemented. Documented here so the model is
> complete and so we know exactly what is and isn't guaranteed in its absence.

**Rule.** For a single verifier `V`, multiple blocks may answer it (each
emitting a self-claimed `{V, data}`), but they must all carry *byte-identical*
`data`. Divergent answers conflict; all but one lose.

This is the answer-model analogue of single-spend. Where a linear UTXO baton
forces a unique successor by *destroying the predecessor*, the uniqueness rule
forces a single-valued answer by *forbidding divergent data*. Both collapse many
possible continuations into one canonical one, and both lean on the same
consensus machinery to do it.

### It is a conflict rule, not local validation

This is the subtlety behind "all but one fail." Two blocks each emitting
`{V, data1}` and `{V, data2}` are *each* locally well-formed. They do not fail
in isolation; they **conflict**, keyed on `V`, and consensus keeps the heavier
one -- exactly like a double-spend. So the rule belongs in the **conflict
module** (indexed by answer-verifier, divergent-data predicate), not in
per-block validation. That indexing is the real implementation cost when this is
un-deferred.

### It only bites for *underdetermined* answers

Sharpen "fail validation" by who pins the data:

- **Computed answers** (`state = f(inputs)`): `run()` recomputes and rejects any
  `data` that isn't the unique correct value. A divergent answer is *locally
  invalid* -- it fails on every node independently. **Uniqueness holds here for
  free, today, with nothing deferred.**
- **Chosen / underdetermined answers** (a move, an oracle reading, raw user
  input): `run()` gates *who/whether*, not *what* (e.g. `requireSignature`
  accepts any signed move). Two validly-signed divergent answers both pass local
  validation. Here the uniqueness rule is the *only* thing preventing
  equivocation, and it does so via the conflict layer.

So the deferred work bites only for underdetermined answers. And even then,
**if the answerer must claim a single incentive UTXO, that incentive's
single-spend linearizes the step anyway.** Concretely: the chess demo (explicit
moves, each paid by an incentive the mover claims) stays correct while
uniqueness is deferred, because the incentive's single-spend is doing the
linearizing. A *self-funded* autonomous answer chain with chosen inputs and no
incentive UTXO is the case that can fork until the rule lands.

### Uniqueness is not correctness

Uniqueness is an anti-equivocation / consistency rule: it makes the answer
*single-valued*. It does **not** make the answer *correct*. A wrong-but-valid
answer (one that passes an expensive `run()` nobody re-checked) is still caught
the same way it always was -- by the [deception game](deception.md) and
collateral, via re-execution and challenge. The two mechanisms are orthogonal
and both required.

---

## Determinism and the purity boundary

Under the answer model, a contract's answer should be a pure function of its
verifier. Not every `ContractEnv` method preserves that. These methods can make
the produced result depend on context (host state, timing, local UTXO set, the
generation/verification mode), so a generator that uses them can produce a
**non-unique** result:

```
mode()        -- branching on generation vs verification
claimAll()    -- the available input set depends on local state/timing
claimNext()   -- which input, and how much value, depends on availability
getResult()   -- the host supplies the bytes
put()         -- the returned sub-block hash depends on context
timestamp()   -- the block's wall-clock time
```

**A generator that calls none of these is safe**: its result is a predictable
function of its verifier (plus referentially-transparent `fetch`es). This is a
*sufficient, statically-checkable* condition. (A contract may still be pure while
calling some of them -- e.g. validating `getResult` against `params`, or calling
`claimNext` only to fund itself without letting the value influence the answer
bytes -- but the protocol can't cheaply prove that, so "doesn't call them" is the
conservative guarantee.)

### `mode` becomes a function

`ContractEnv.mode` changes from a property to a method, `mode(): ExecutionMode`.
The reason is exactly the purity boundary: a *call* can be observed by the env,
so the runtime can record that a generator branched on mode (and is therefore
potentially non-unique). A bare property access cannot be intercepted.

> Code status: the WASM ABI surface already exposes `mode` as a function
> (`env.mode()` in the wasi-shim, `mode: () => ...` in the host bridge). Only the
> TypeScript `ContractEnv` property and its few call sites remain to migrate.
> Tracked in [`TODO.md`](../../TODO.md).

### `timestampGte` instead of `timestamp`

`timestamp()` leaks the block's actual time into the result, making it
non-unique. Most uses of `timestamp()` only need a *lower bound* (decay windows,
"not before"), which can be expressed as an assertion that does not leak:

```
timestampGte(timestamp: number): void   // require block.timestamp >= instant
```

In verification it checks `block.timestamp >= instant`; in generation it
constrains the draft's timestamp. The block's timestamp still varies (so the
block hash varies), but the *answer bytes* do not depend on it, so uniqueness is
preserved. We plan to add `timestampGte` and potentially remove `timestamp()`
once its remaining callers (collateral/insurance decay, game-state expiry) are
migrated. Tracked in [`TODO.md`](../../TODO.md).

---

## Worked example: state chains and meshes

A chain of state is the common case. Model the state at each step as an answer
whose verifier is stable in the chain identity and indexed in `params`:

```
GAME_HEAD/{gameId, moveIdx}.run(env):
  if moveIdx == 0:
     require state == INITIAL_STATE              // base case
  else:
     prev = fetch(GAME_HEAD/{gameId, moveIdx-1})  // referentially transparent
     move = fetch(playerMove/{gameId, moveIdx-1})
     requireSignature(players[(moveIdx-1) % 2])
     require state == reduce(prev, move)
  setResult(state)                                // publish the answer
```

- The previous state is read with `fetch`, not consumed. No per-step UTXO, so a
  world of millions of chunks does not pollute the global unspent set with
  millions of batons. The unspent set stays for *value*; answers are *data*.
- Equivocation is handled at the right layer: a player *may* sign two moves at
  the same index, but both target `playerMove/{gameId, moveIdx}` and the
  uniqueness rule (or, until then, the move's incentive single-spend) collapses
  them to one.
- **Meshes, not just chains.** Because dependencies are expressed by `fetch`,
  not by consuming one predecessor token, a chunk can depend on its *neighbors*
  at the previous tick:

  ```
  chunkState/{chunk, T}.run(env):
     self  = fetch(chunkState/{chunk, T-1})
     for n in neighbors(chunk):
        ns = fetch(chunkState/{n, T-1})
     setResult(simulate(self, neighbor_states))
  ```

  A linear UTXO baton structurally cannot express this (you'd consume N
  predecessor tokens and produce... what?). The answer/fetch model handles the
  2D/3D simulation mesh for free. This is why the model is *more general*, not
  merely cheaper.

A side benefit: `fetch(chunkState/{chunk, T})` for the latest computed `T` is
the natural "current state" query. (When to prefer a stable "live" verifier vs.
per-index snapshot verifiers is a per-application choice -- decide it
deliberately rather than letting it fall out by accident.)

### Index requirements: exact vs. best-effort

The "no UTXO pollution" win is precise, and it is about *which kind of index*,
not whether one exists. `fetch` still needs a `V -> block` discovery index of
similar cardinality. The difference is in the requirements:

- The **UTXO index** must be **complete, global, and exact** -- double-spend
  safety depends on it being right everywhere, even for verifiers no node cares
  about.
- The **answer discovery index** can be **sparse, local, and best-effort** -- a
  stale or missing entry just means you `ref` a block that might be
  non-canonical, and your block rides its fate (the usual build-on-canonical-tip
  discipline). A node only indexes answers for verifiers it cares about.

Plus self-claimed answers are consumed in-block, so they are *not in the unspent
set at all*.

---

## Two models, tentatively

> Exploratory. Joel has not committed to this framing; it is recorded for
> continuity, not as settled protocol. Do not build on the boundary.

The discussion surfaced what looks like two complementary data-passing
mechanisms, chosen by the nature of the resource:

| | Claim / UTXO model | Fetch / answer model |
|---|---|---|
| For | value-bearing, context-dependent, must-happen-once | pure-function data, read-many |
| Purity via | consume-once (single-spend) | single-valued map (uniqueness) |
| Linearized by | the spent output | the conflict rule (or, until then, an incentive UTXO) |
| Example | collateral postings + resolution, money | chunk/game state, hash answers, compiled output |

The tension that keeps this from being clean: uniqueness-per-`V` assumes the
answer is a pure function of `V` *alone*. Some resources legitimately depend on
block context. The clearest case is the **collateral verdict**, whose resolution
depends on decay over `block.timestamp`: two honest resolvers at different times
compute different (each-correct-for-their-time) verdicts, which uniqueness-per-`V`
would force into conflict. Such resources seem to belong in the claim model
(they consume the collateral UTXOs; single-spend already linearizes them) rather
than being forced into the answer model. But the exact boundary -- which
resources are "pure function of `V`" vs. not -- is the one line that will be felt
later if drawn wrong, and it is explicitly **left open** pending more thought.

---

## Open questions and deferred work

- **Implement uniqueness** as a conflict-module rule keyed on answer-verifier.
  Until then, underdetermined self-funded chains can fork (see above).
- **The claim-vs-fetch boundary** -- which resources are pure-function-of-`V`
  answers vs. context-dependent claim resources. Left open.
- **Determinism blast radius.** A non-deterministic contract (map iteration
  order, float rounding, etc.) now surfaces as a *network-wide divergent-answer
  conflict and orphaning*, not merely a local verify mismatch. Contracts that
  produce answers must be bit-deterministic; worth a hard callout wherever
  contract authorship is documented.
- **Answer retention / pruning.** Answers are reachable via `refs` indefinitely;
  a million-chunk world accumulates tick history. When a node may forget
  `chunkState/{chunk, T=5}` once `T=1000` is final is a data-retention question
  distinct from value-pruning. Not a blocker.
- **`mode` -> function and `timestamp` -> `timestampGte`** code migrations.
  Tracked in [`TODO.md`](../../TODO.md).
- **Host-input parking.** With `request` removed, the "park until the UI
  responds" behavior moves to `getResult` / `fetch` blocking on an
  as-yet-unpublished answer. Reconcile with the generation-lifecycle state
  machine work in `TODO.md`.

---

## Interaction with other modules

| Module | Impact |
|--------|--------|
| [Computation](computation.md) | Replaces the `request` / `record` contract surface with `setResult` / `getResult` / `fetch` / `put`. Answers are the self-claimed outputs that doc already describes. |
| [Output data](output-data.md) | An answer's `data` is walked/built by the same walker/builder interface. |
| [Conflict](conflict.md) | Gains a new conflict dimension when the uniqueness rule lands: divergent answers under the same verifier conflict like a double-spend. |
| [Piggyback](../design/piggyback.md) | `getResult`'s piggyback path; the self-describing answer makes the inverted index local. |
| [Collateral resolution](collateral-resolution.md) | FOR/AGAINST postings are *messages* (read via `claimAll`); the verdict is an *answer*. The context-dependent verdict is the motivating case for the open claim-vs-fetch boundary. |
| [Trust gate](../design/trust-gate.md) | Reads the verdict answer; safe without a producer ACL because the self-claim forced `run()` to validate it. |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/ContractEnv.ts`](../../src/core/ContractEnv.ts) | `setResult`, `getResult`, `claimNext`/`claimAll`, `fetch`, `put`, `send`, `mode`, `timestampGte` (planned) |
| [`src/core/GeneratingEnv.ts`](../../src/core/GeneratingEnv.ts) | Generation-mode production of answers and structural incentive claims |
| [`src/core/VerifyingEnv.ts`](../../src/core/VerifyingEnv.ts) | Verification-mode checking of answers against the block |
| [`src/contracts/HashContract.ts`](../../src/contracts/HashContract.ts) | `getResult` answer producer (preimage validated against `params`) |
| [`src/contracts/HelloContract.ts`](../../src/contracts/HelloContract.ts) | `setResult` answer producer |
| Future: conflict module | Answer-verifier uniqueness as a conflict-resolution rule |
