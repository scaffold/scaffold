# Brainstorm: Global State, Answer Uniqueness, and Prior Art

> Status: **brainstorm output, not settled protocol.** Produced by a structured
> multi-agent brainstorm (4 divergent lenses + adversarial stress test) in
> response to Joel's question: *what pre-existing models of computation fit
> the answer/fetch model and its uniqueness problem, and what other ideas fit
> the use case?* Nothing here is a decision. The starting point is
> [results.md](../protocol/results.md) (answer model, deferred uniqueness
> rule) — read that first.

---

## The problem, restated

We need `fetch({contract, params})` to behave as a referentially transparent
*function* (single-valued per verifier V) even for **underdetermined** answers
(signed moves, oracle readings, injected host data), enforceable by browser
clients that hold only a sparse local view and forget blocks quickly — without
a complete global per-V index, and without forcing contract authors to solve
canonical params serialization.

Two findings frame everything below:

1. **The index-completeness contradiction.** results.md simultaneously wants
   uniqueness to be "a conflict rule ... exactly like a double-spend" and the
   answer-discovery index to be "sparse, local, and best-effort." Double-spend
   safety is precisely the case the same doc says needs a *complete, global,
   exact* index. Divergent answers only conflict if some node holds both blocks
   while both are retained; the design permits that probability to be ~0
   (split-horizon equivocation: ~2 coins of cost, unbounded theft).
2. **Presentation-slashing doesn't survive the decay parameters.** Equivocation
   evidence (two signed divergent answers) is timeless, but everything slashable
   at the block level decays in seconds (collateral half-life ~2.3s). Late
   evidence has nothing to bite. Writer-level bonds fix the lifetime but
   reintroduce a global, persistent registry — the exact completeness cost the
   answer model exists to shed. Worse, any open finder's-reward is self-dealable:
   the equivocator presents their own pair to two aggregators' insurance and
   pockets `2·alpha·R ≈ 1000` per event at ~2 coins cost.

---

## Prior art survey

Three strong convergences across independently developed systems:

### Convergence 1: identity-by-genesis-hash beats identity-by-canonical-description

Discovered independently by Ceramic (StreamID = hash of genesis commit), Chia
(singleton launcher ID = spent genesis coin), Aleo/Zexe (nullifiers = hash
derived from the consumed record), Nix (derivation hash), Unison (AST hash),
IPFS/IPLD (CID; "the bytes are the identity, normalize at write time").
Nobody successful makes the protocol parse application encodings — Protobuf's
own docs ("Proto Serialization Is Not Canonical") are the cautionary tale.
Serialize the question **once, at birth**; address the cell by hash thereafter.

### Convergence 2: self-contained, context-free equivocation evidence is the only kind that survives forgetting

Hypercore/Dat fork proofs (two signed entries at one seq), Tendermint
`DuplicateVoteEvidence`, Lightning revoked-state penalties (bounded by a
contestation window — the load-bearing feature, not a bug), Certificate
Transparency split-view STH pairs. All reduce misbehavior to "two small signed
atoms, verifiable structurally, forever, without app context." Any Scaffold
equivocation evidence should be checkable without loading contract WASM or
forgotten history.

### Convergence 3: unwatched enforcement rules atrophy; watching must be paid or forced

CT's gossip protocol (assumed by everyone, never deployed — split-view
detection remained vapor) is the negative example. Truebit's forced errors,
Lightning's watchtower market, and Scaffold's own deception equilibrium are the
positive ones. AGAINST-challenge-as-paid-query is the right instinct; any
uniqueness rule needs its own funding loop from day one or it will not be
watched.

### Per-system map

| System | Mechanism | Steal | Reject |
|---|---|---|---|
| **Single-use seals / RGB** (Peter Todd) | State lives client-side with interested parties; the global layer provides exactly one fact: "this outpoint was spent once" | The decomposition. The "incentive single-spend linearizes anyway" observation in results.md is a single-use seal — treat it as *the primitive*, not a crutch | External-L1 anchoring; pairwise-only data transfer |
| **Ceramic streams** | StreamID = hash of genesis commit; updates are signed log events; anchor + conflict rules pick one tip | Genesis-hash identity for long-lived cells | Centralized anchor service; earliest-anchor-wins as primary rule |
| **Hypercore / Bamboo / SSB** | Single-writer signed logs; fork = two signatures at one seq = portable proof | Evidence-format discipline (see Convergence 2) | "Writer excluded forever" bluntness; global single-writer constraint |
| **CT / CONIKS / WhatsApp key transparency** | Signed epoch tree heads; consistency proofs; clients hold O(1) roots and detect equivocation later | Epoch-root commitments riding aggregation roots (they're already signed + collateralized); witness-cosigning ≈ aggregators | Single log operator; unpaid gossip (see Convergence 3) |
| **Holochain** | Agent chains + validating DHT: hash-neighborhood peers validate/store; warrants propagate | Deterministic hash-proximity assignment of *paid* retention duty; warrants = portable misbehavior proofs | Weak story vs. neighborhood collusion; punts on global singletons |
| **EUTXO threads / Chia singletons** | Uniqueness inherited forever from one consumed genesis outpoint; covenants constrain successors | Genesis-consumption **once per cell**, not per update | Per-update batons for computed state (the fetch-mesh argument stands) |
| **Celestia / LazyLedger** | Consensus = ordering + data availability only; execution deferred to interested clients; DAS for light clients | The framing: the global layer should guarantee answers are *ordered and available for the contestation window*, not re-executed | — |
| **Truebit / Arbitrum / optimistic rollups** | Accept-then-challenge; forced errors keep verifiers paid | Forced equivocations extending the deception equilibrium to the uniqueness layer | — |
| **Mina / Verkle / stateless clients** | Constant-size validity proofs; witness-carrying blocks | Checkpoint answers as retention horizon; optional ZK endgame (swap a checkpoint's verifier from re-execution to a proof — it's just a different contract) | SNARKs as the core mechanism (wrong cost model for browser-first writes) |
| **Nano block-lattice** | Per-account chains; consensus invoked *only on observed forks* | Lazy conflict — pay for ordering only when divergence appears (Scaffold already has this; keep it) | — |
| **Aleo/Zexe records** | Birth/death predicates (≈ generator/verifier); nullifier set for double-consume detection | Contract-derived opaque conflict keys | The *global* nullifier set |
| **Unison / Nix / Bazel / Adapton** | Content-addressed computation; memo tables; demand-driven invalidation | The mental model: `fetch(V)` is a distributed **memo-table lookup**. Computed answers are cache entries — regenerable, hence freely forgettable | — |
| **CALM theorem / CRDTs / Bloom** | Consistency without coordination iff monotone; coordination needed exactly at non-monotone points | The classifier (see below). CRDT joins only for genuinely lattice-shaped namespaces | CRDT merge as general game-state semantics |
| **Linda tuple spaces / Kahn networks / Croquet** | `rd` vs `in` duality; single-writer channels ⇒ determinism; game worlds need consensus only on a tiny ordered event log (reflector) | All three: fetch/claim ≈ rd/in (40-year-old validation); single-writer idiom; **reflector-as-baton** for game worlds | Blocking pattern-match `in`; trusted reflector |
| **JCS (RFC 8785) / dCBOR / IPLD** | Canonical encodings vs. hash-of-bytes identity | Hash-of-bytes at protocol layer; canonical JSON as a *client-library/codec default* (json-wb builder) | Protocol-level JSON awareness of any kind |
| **PoS double-sign slashing / Lightning penalties** | Penalty upon presentation of two signed messages, within a bounded contestation window; watchtower market for outsourced watching | The contestation-window framing: decaying collateral *is* the window. Watchtowers as a paid role if slashing is ever load-bearing | Registry-identity slashing (Scaffold answerers are permissionless) |

### The sharpest reframe: CALM classifies the two answer kinds exactly

The CALM theorem (Hellerstein & Alvaro): a problem has a consistent,
coordination-free distributed implementation **iff it is monotone**.

- **Computed answers are monotone.** More information never retracts the
  answer; re-execution confirms it. CALM says: no coordination needed — which
  is exactly results.md's "uniqueness holds here for free, today."
- **Underdetermined answers are non-monotone choices.** A second signed move
  retracts "this is the move." CALM says coordination there is *provably
  unavoidable* — the only design freedom is choosing the cheapest coordination
  primitive: a single-spend seal, a single-writer slot, or a witness quorum.

So the question is not "how do we make all answers unique" but "how do we
confine coordination to the non-monotone slots and make its evidence
self-contained."

---

## The composite proposal: seal-or-compute

The strongest synthesis (all four lenses converged on its core independently),
**as amended by the stress test** — the first-draft version fails open and the
amendments are load-bearing.

1. **Purity typing.** Classify every answer namespace using the existing
   statically-checkable purity boundary in results.md: **computed** (calls none
   of `mode/claimAll/claimNext/getResult/put/timestamp`) vs **choice**.
2. **Computed answers get no uniqueness machinery at all.** Re-execution
   rejects divergence locally (true today). They are memo-table entries:
   regenerable, freely forgettable, no retention duty. This resolves the
   answer-retention open question for them: cache loss is latency, not safety.
3. **Choice answers must consume a *named seal* — a single-spend input whose
   lineage traces to the cell's genesis.** Equivocation then becomes an
   ordinary double-spend, detected by the existing complete UTXO/conflict
   machinery via the aggregation spine (which everyone retains), independent of
   answer-index retention — the same guarantee money has, no weaker. The
   deferred per-V uniqueness conflict rule is **deleted**.
   - *Named*, not described: `params` embeds the seal's `{block, outputIndex}`
     or the contract enforces genesis lineage. Without this, an equivocator
     mints a fresh dust seal via `send` and no conflict ever occurs — the
     first-draft rule enforces nothing.
   - Incentives are payments, **never** seals (two honest bounties on one
     question would otherwise fork the seal identity).
4. **No equivocation penalty.** Losing a seal conflict = losing a consensus
   race (consistent with trust.md). This also kills the self-flag-harvest
   attack: equivocation via seals produces two *valid* blocks, so there is no
   invalidity for insurance to pay a "finder" on.
5. **Params identity: opaque bytes at the protocol layer.** Canonical JSON is a
   json-wb builder default (client library), not protocol. Long-lived cells use
   genesis-hash identity — which is not an optional flavor: it is the mandatory
   substrate for seal lineage (3). Residual encoding variants are distinct
   questions; bounties make one encoding focal ("money canonicalizes"), and
   infrastructure cells canonicalize by dependency (whichever genesis hash
   downstream contracts hardcode).
6. **Game worlds: per-region injection baton (Croquet reflector, decentralized).**
   Player inputs enter as unclaimed value-bearing messages; the region's baton
   (an ordinary UTXO thread) is claimed each tick, and the claiming block folds
   the messages deterministically. Every `chunkState/{c,T}` is then a *computed*
   answer derived by fetch-mesh from baton history: uniqueness for free across
   millions of chunks, zero per-chunk UTXOs, checkpoints for late join.
7. **Invariants to add to results.md** regardless of the rest:
   - Answer/seal conflicts use **effective (pessimistic-pending) weight**, never
     declared weight (otherwise answer-sniping via private weight is open).
   - Risk-tiered fetch: computed contracts *may* ride un-aggregated answers
     (games) but riding aggregated, insurance-backed answers is the safe mode
     (oracles) — orphan-cascade exposure is a priced choice.
   - Aggregated answers carry a **data-availability obligation**: the
     insurance-staking aggregator must serve preimage challenges.

### Stress-test verdicts and the required work list

Component verdicts: purity typing **(b)** — sound for direct effects, unsound
through fetch without taint tracking; computed-no-machinery **(a)**; seal rule
**(b)**, and **(c)** as first drafted — the named-seal amendment is mandatory;
no-penalty **(a)**; opaque params + genesis identity **(a)**; region baton
**(b)**; invariants **(b)**.

Composite: **promising but needs work.** The architecture converts both framing
findings into non-problems (computed answers need no index) or money-grade
problems (seal double-spend detected via the spine). The bounded work list:

1. **Seal-lineage primitive.** Verification must see a claimed input's
   producing block and check one structural fact (lineage/genesis). The data
   exists (claim migration resolves every claim to `{block, outputIndex}`) but
   is not exposed to spending-condition verification. New protocol work, local
   O(1)-per-hop — replacing a global, complete, retention-dependent index.
2. **Fetch-taint rule.** A computed answer's every fetched verifier must be
   (i) itself statically pure, or (ii) answered by a seal-consuming block.
   Without transitive taint, a pure contract fetching an unsealed choice answer
   yields two valid divergent "computed" answers (each re-verifies against its
   own ref) and the typing is unsound.
3. **Visible-set pinning for batons.** "The baton block must claim all
   unclaimed message outputs under the message verifier present in its anchor's
   output space." Censorship becomes an AGAINST-challengeable validity fault
   (~C1=1000 at risk per censored tick) instead of unfalsifiable. Messages
   carry value (the sequencer's fee — spam pays the claimant, and satisfies the
   `claimNext` value>0 rule). Fee-priority ordering, not sort-by-hash (hash
   order is grindable). Residual: stale-anchor censorship, bounded by max
   anchor staleness aggregators accept (a parameter).
4. **Baton lifecycle.** `timestampGte` timeout so anyone may claim a stalled
   baton (unsticker earns accumulated message fees — busy regions self-heal,
   quiet regions stall vacuously); heartbeat re-claims; dust value + inactivity
   timelock so zombie batons of dead games are claim-and-retired (else ~10^7+/yr
   permanent residue at plausible churn — must be in the baton convention from
   day one, expiry can't be retrofitted onto immortal outputs).
5. **WASM determinism enforcement at module admission** (NaN canonicalization,
   no nondeterministic features). Under seal-or-compute, a nondeterministic
   "computed" contract surfaces as a validity split-brain, a *worse* failure
   mode than the old divergent-answer conflict. Known art (NEAR, Polkadot).
6. **Pattern prohibition: never post an open incentive on a raw choice
   verifier.** Seal-race sniping on "anyone may answer" choice questions is
   strictly dominant for the attacker: the snipe is *valid* (nothing to
   dispute, collateral decays back, AGAINST challengers pay the sniper), EV ≈
   0.5·(bounty + downstream stake) − 1. Open questions must be built as
   computed folds over choice messages (Schelling-style), reducing to case 3.
   "Uniqueness ≠ correctness" is real: the deception game adjudicates
   *validity*, and choice answers are valid by construction — their truth is
   gated only by the contract's own `run()` (who may answer), so design the
   `run()` accordingly.

### Scale check (seal-set growth)

10^6 concurrent games + 10^4 regions + 10^3 oracle feeds ≈ 1.01M live seals —
low hundreds of MB across aggregation caches, and dwarfed by the money UTXOs
the same activity generates. Joel's pollution objection was the per-chunk mesh
(10^8-10^9); per-region batons with computed chunks is a 10^4-10^5× reduction.
The real term is zombies (hence work item 4).

---

## Runner-up ideas worth keeping

Ranked; each stands alone even if the composite is rejected.

1. **Answer-map epoch roots on aggregation roots** (CT/CONIKS pattern). Add to
   the aggregation cache a root over the subtree's (answer-key → hash(data))
   map, merged up the tree. Clients forget everything but O(#epochs) roots;
   "did V ever get a different answer?" becomes a *paid* inclusion/consistency
   proof query (the economics CT's gossip never had). Complements or replaces
   seals for audit; cost lands on aggregators, priced into f, disputable like
   any aggregation data. Medium confidence.
2. **Uniqueness as an aggregation-validity predicate.** A subtree containing
   divergent answers for one V is invalid — enforced by the existing
   probe/insurance economy at O(log N) merge points, using compact per-subtree
   answer-key commitments (bloom/merkle). Detection window = aggregation
   window = exactly the retention nodes already have. Weaker than seals
   (parallel branches that never share an ancestor both die unpunished, but
   also never both become canonical). If slashing is added, pay the deceived
   aggregator or burn — never an open finder (self-dealing). Medium confidence.
3. **Single-writer envelopes** (Kahn/Hypercore/Tendermint). A standard
   structural envelope for injected data — (pubkey, channel, seq, sig over
   (channel, seq, hash(data))) — makes equivocation evidence verifiable without
   contract WASM or history, and shrinks any conflict indexing from
   "all answers by V + divergent-data predicate" to "(writer, channel, seq)".
   Useful *inside* the baton fold regardless of the composite. High confidence
   as a convention; the slashing half remains subject to the evidence-lifetime
   problem.
4. **Checkpoint roll-ups as the retention horizon** (Mina-shaped, economically).
   Each re-aggregation emits an insured `checkpoint/{cell,T}` answer;
   everything behind the latest sampled checkpoint may be forgotten, disputes
   run against the checkpoint poster's insurance; ZK-ready later with zero
   protocol change. Directly answers results.md's open retention question.
   Medium-high confidence.
5. **CRDT/lattice namespaces.** For genuinely join-semilattice state (counters,
   sets, presence), `fetch` returns the join — unique by algebra even when
   answers aren't. Opt-in per namespace; not general game semantics. Low-medium
   confidence, narrow scope.

---

## Attack registry (new; not in attacks.md)

Attacks on the *current documented* direction (uniqueness-as-conflict +
best-effort index), kept here so they aren't lost. Parameters from deception.md.

| Attack | Cost | Benefit | Status under composite |
|---|---|---|---|
| **Split-horizon answer equivocation** — divergent answers to disjoint audiences; wait out retention | ~2 | unbounded | Killed by named seals (detected via spine, money-grade) |
| **Self-flag harvest** — equivocate across two aggregators, self-present evidence, collect 2·alpha·R from both insurances | ~2 | ~1000/event | Killed (valid blocks → nothing for insurance to pay on) |
| **Answer-sniping via rented weight** — flip "the answer" after victims commit | ~W·v | market value | Mitigated by pessimistic-pending invariant; snipe window is pre-descendant-weight |
| **fetch-poison orphan cascade** — front-run a hot V; downstream refs ride and orphan | ~1 | grief ratio ~2N:1 | Mitigated by risk-tiered fetch; residual for fast-path riders (priced) |
| **Cite-then-hide** — serve answer data only to the mark; late verifiers can't re-execute; collateral decays clean | ~1 | downstream take | Mitigated by DA obligation on aggregated answers; fast path residual |
| **Params variant flooding / canonicalizer friendly-fire** — poison plausible encodings, or weaponize honest cross-stack canonicalization divergence | ~20 / ~0 | poisoning + orphaning | Killed by opaque-bytes + genesis-hash identity (no protocol canonicalizer to attack) |
| **Chunk-squatting / region extortion** — sole answerer + sole data holder of a cold region; read tolls via AGAINST bonds; withhold ticks | low | monopoly rent | Partially mitigated (DA obligation, checkpoints for re-bootstrap); **needs the checkpoint mechanism to land** |
| **Partition-timed meaning reorg** (nation-state) — divergent oracle answers to two partitions; pick the surviving reality by weight after heal | high | reality control | **Open.** Inherits the value layer's partition exposure; "meaning" amplifies it. Only defense: finalization latency vs. partition duration. Deserves an attacks.md entry |

---

## Open questions for Joel

1. Accept the two new local primitives (seal lineage visibility in claim
   verification; fetch-taint rule) as the price of deleting the global per-V
   conflict index? That's the crux of the composite.
2. Is `getOutput`/`getResult`-style host injection willing to move behind
   seals/batons universally, or do we keep a documented unsafe fast lane?
3. Region granularity for batons: per-game-world region is a throughput/MEV
   tradeoff (Croquet's reflector bound). Sharding policy is app-level; does the
   protocol need to say anything?
4. Do we want the epoch answer-map roots (runner-up 1) *in addition* to seals,
   as the audit/history layer? They're independent and compose.
5. The determinism-enforcement scope for "computed" WASM (work item 5) — module
   admission checks vs. runtime canonicalization.
