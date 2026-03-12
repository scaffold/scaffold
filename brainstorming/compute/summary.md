# Computation & Verification Brainstorming — Summary

## Explorations

### 1. The Computation-Oracle Model ([details](explorations/01-computation-oracle-model.md))

**Direction**: Model every computation as a deterministic WASM execution
with an optional **oracle log** — a record of external data fetched during
execution (hash lookups, merkle subtrees, etc.). The oracle log makes
interactive computations reproducibly verifiable: a verifier replays the
log rather than fetching live data.

**Key implications**:
- **No block schema changes** — everything is expressed through standard
  contracts (COMPUTATION_REQUEST, COMPUTATION_RESULT, DATA_COMMITMENT,
  STATE_QUERY, etc.)
- **Two-level verification**: (1) computation verification = re-execute
  WASM with same inputs and oracle responses; (2) oracle verification =
  check that oracle responses are independently valid (hash checks, merkle
  proofs, etc.). These can be challenged independently.
- **Challenges and queries share mechanical primitives** (request output →
  response block) but differ in spending conditions: challenges affect
  block validity (non-response = fraud evidence); queries are purely
  economic incentives.
- **MITM protection varies by computation type**: expensive computations
  get natural protection from the deception game (relays can't cheaply
  verify); cheap-to-verify computations (hash lookups) need a two-stage
  commitment scheme.
- **Deception game integration is direct**: publishers occasionally
  produce wrong computation results; verifiers catch them by re-execution;
  aggregators probe before incorporating. The oracle log doesn't affect
  this dynamic — it just makes re-execution deterministic.

**Main risk**: Oracle log can grow large for complex computations; may
need its own merkle commitment. The interaction between oracle
verification and computation verification needs careful specification.

**Comparison positioning**: This is a refinement of Option 3 from the
brainstorming prompt (query-based with local/remote distinction). It adds
the oracle log concept for reproducible verification. Compared to Option 1
(each block defines own verification), it's more constrained but more
trustworthy. Compared to Option 2 (legacy2 collateral voting), it's
simpler — verification is binary, and the existing trust module handles
economics.

---

### 2. The Self-Catching Deception Game ([details](explorations/02-self-catching-deception-game.md))

**Direction**: Deep-dive into the game theory of the deception
equilibrium. Publishers publish **insurance commitments** (a hash of the
correct result) alongside their blocks. If nobody catches an intentionally
invalid block, the publisher self-catches and claims the aggregator's
collateral as a jackpot. This funds the verification layer and prevents
MITM re-attribution.

**Key implications**:
- **Insurance commitments** are the key primitive: `HASH(correct_result ||
  secret)` published as an output on the publisher's FOR collateral block.
  No extra blocks needed.
- **Quantitative equilibrium**: With the prompt's numbers (+1 honest, -1000
  caught, +1M jackpot), the equilibrium fraud rate is 0.1% and the
  catch rate is 99.9%. The verification layer is well-funded.
- **MITM protection is emergent**: For expensive computations, re-attribution
  without verification is negative expected value (-0.001 per block).
  The MITM can't self-catch (no insurance commitment), so claiming
  unverified results is unprofitable. For cheap-to-verify computations,
  MITMs can filter traps, so the commitment scheme from Exploration 1
  is still needed.
- **Universal insurance recommended**: Every publisher should publish
  insurance (not just deceivers), so traps are indistinguishable from
  honest blocks. The cost is one extra hash output on the FOR
  collateral block.
- **Self-correcting equilibrium**: fraud↓ → verifiers exit → fraud↑ →
  equilibrium restores. No protocol intervention needed.
- **Error flagging**: Publishers who discover accidental errors can
  self-catch, earning the jackpot instead of silently losing collateral.
  Incentivizes proactive error correction.

**Main risk**: Insurance privacy — if the commitment can be checked
against the claimed result (e.g., by trying HASH(claimed_result || S)),
verifiers could identify honest blocks vs traps. The secret S must be
large enough to prevent this. Also, the j/c ratio (jackpot/collateral)
is not a tunable parameter but emerges from aggregation staking levels,
which may or may not produce the desired equilibrium.

**Comparison positioning**: Complementary to Exploration 1. Exploration 1
provides the *mechanism* for verification (oracle logs, re-execution).
Exploration 2 provides the *incentive* for verification (deception game,
insurance commitments). Together they form a complete computation and
verification model. Both require no block schema changes. Compared to
legacy2's 7-vote-type collateral system, the self-catching game is
dramatically simpler — just FOR/AGAINST collateral plus insurance
commitments.

---

### 3. Offline State, Challenges, and the Validity Lifecycle ([details](explorations/03-offline-state-and-challenge-lifecycle.md))

**Direction**: Deep-dive into secret/offline state as a protocol-level
concern. Blocks store only a commitment (merkle root); actual data lives
with the publisher. Designs the challenge-response mechanism, block
validity lifecycle, and resolves whether challenges and queries should
be unified.

**Key implications**:
- **Challenges and queries are SEPARATE primitives** (revising E1's
  "same mechanics" conclusion). Challenges are adversarial (staked,
  affect validity); queries are cooperative (bountied, no validity
  impact). Queries can escalate to challenges when responses are invalid.
- **Challenged ≠ invalid** (softening the prompt's claim). Pending
  challenges make blocks UNVERIFIED, not invalid. This is economic
  pressure (reduced trust, aggregation reluctance), not structural
  prohibition. Making pending = invalid would enable DoS via challenge
  spam.
- **Anti-spam via challenge collateral**: challengers must stake
  collateral. If the publisher responds correctly, the challenger
  loses their stake. This makes frivolous challenges expensive.
- **Validity lifecycle**: PRESUMED_VALID → CHALLENGED → DEFENDED or
  FRAUDULENT. Aggregators should not aggregate blocks with pending
  challenges (rational choice, not protocol rule).
- **Commitment outputs** carry a merkle root + schema WASM hash.
  The schema exports `validate(root, path, proof) → bool` and
  explorer functions (list/read/type extended with a proof parameter).
- **Interactive verification**: unlike computation (re-execute locally),
  offline state verification requires interacting with the publisher,
  making it slower and more expensive. The deception game applies but
  with different parameters.
- **Aggregation options**: carry commitment forward (cheap, publisher
  keeps custody), absorb state (expensive, aggregator takes custody),
  or inline if small enough.

**Main risk**: Challenge deadlines and response windows need careful
tuning — too short and publishers can't respond in time; too long and
blocks stay in limbo. State availability after publisher disconnects
is unresolved (who answers queries?). Nested offline state (commitments
within commitments) could create unbounded interaction depth.

**Comparison positioning**: Complements E1 and E2. E1 provides the
computation model, E2 provides verification incentives, and this
exploration handles the third pillar: offline data that can't be
verified by re-execution alone. Key disagreement with E1: challenges
and queries should NOT be unified — they have fundamentally different
adversarial properties. Compared to legacy2's voting system, the
challenge-response model is simpler: proofs either validate or they
don't, no voting hierarchy needed.

---

### 4. The WASM Interface and Protocol Synthesis ([details](explorations/04-wasm-interface-and-synthesis.md))

**Direction**: Synthesize E1-E3 into a concrete, implementable design.
Defines the actual WASM host interface, resolves tensions between
explorations, and works through end-to-end block flows for every use
case.

**Key implications**:
- **Program as contract**: the computation WASM IS the spending condition.
  Its hash identifies both the program and the contract. No separate
  COMPUTATION_REQUEST/COMPUTATION_RESULT types — the program hash is the
  contract hash. This dramatically simplifies the contract landscape.
- **Self-perpetuating computation chains**: the result output uses the
  same contract as the request. Game state flows through a chain of
  UTXO claims: output(state_N) → claim → output(state_N+1) → claim → ...
  Each link is independently verifiable.
- **Minimal WASM interface**: programs export `compute(input) → output`.
  The host auto-generates `verify()` by re-executing and comparing.
  Optional exports: `weight()`, explorer functions, `validate()`.
- **Oracle log as self-claimed output**: resolves E1's open question.
  Small logs inline; large logs committed as merkle root and served
  via E3's offline state mechanism.
- **Concrete host functions**: `output_data()`, `block_output_data(i)`,
  `oracle_fetch(request)`, `accept()`/`reject()`. Clean, minimal API.
- **Result output convention**: the first output on the claiming block
  with a matching contract hash is the result. Unambiguous.
- **Tensions resolved**: oracle log placement, challenge vs query
  distinction (E3 is right — separate), insurance scope (covers
  concatenated verification-relevant output data), result identity.

**Main risk**: WASM determinism (floating-point variation across
platforms), execution limits (unbounded verification cost), and
contract versioning (state migration when program hash changes).

**Comparison positioning**: This is the synthesis layer. E1 provided
the computation model, E2 the incentives, E3 the offline state
lifecycle, and E4 the concrete interface binding them together.
Program-as-contract is simpler than E1's multi-contract approach.
Seven new standard contracts total (plus any application WASM).

---

### 5. Critical Review and Decision Points ([details](explorations/05-critical-review-and-decisions.md))

**Direction**: Stress-test the E1-E4 synthesis. Identify weaknesses,
attack vectors, integration gaps, and prototype ordering.

**Key implications**:
- **Oracle logs downgraded** from "key primitive" to "optional
  complexity." Most use cases work without them. Live re-fetch during
  verification works for immutable oracle data (hash lookups). Mutable
  oracle data is better handled through E3's offline state commitments.
  Recommend deferring oracle logs to a late phase.
- **Two-stage commitment downgraded** for data lookups. Data delivery
  is the primary goal; attribution is secondary. Accept MITM risk
  initially; add commitment scheme only if it becomes a real problem.
- **Gas/instruction limits are critical** and weren't addressed in
  E1-E4. `declaredWeight` should directly determine the WASM instruction
  budget. This prevents computation bombs, makes weight meaningful (you
  can't inflate weight without doing the work), and tightly couples
  consensus influence to actual computation.
- **Insurance privacy is a non-issue**: by the time a verifier can
  check the insurance commitment, they've already re-executed the
  computation and know the answer directly. The 256-bit secret is
  sufficient.
- **Attack vectors analyzed**: computation bombs (mitigated by gas
  limits), oracle amplification (oracle calls cost gas), challenge
  griefing (rate limiting + challenger pays if wrong), self-dealing
  deception (harmless — breaks even), stale state (handled by conflict
  module), contract poisoning (social/market problem, not protocol).
- **Sampling module integration**: verification cost should factor
  into sampling priority. `priority(T) = swing × dampening /
  verification_cost(T)`. The gossip module needs extension for
  contract-hash-based routing.
- **Prototype phases**: (1) program-as-contract, (2) computation
  chains, (3) deception game, (4) offline state, (5) oracle calls.
  Each phase independently valuable and testable.

**7 key decisions identified** (see exploration for details). Most
important: weight = gas budget, defer oracle logs, accept data MITM
initially, contract-declared challenge stakes.

**Comparison positioning**: Not a new design direction but a maturity
assessment. Strengthens confidence in the core (program-as-contract,
deception game, challenge ≠ invalid) while simplifying the periphery
(oracle logs, two-stage commitments). The phased prototype plan turns
the brainstorming into an actionable roadmap.

---

### 6. Computation Chain Dynamics ([details](explorations/06-computation-chain-dynamics.md))

**Direction**: Analyze how the deception game, verification, and chain
recovery interact in self-perpetuating computation chains (the E4 pattern
where each computation's result output IS the next computation's request).
A trap at link N invalidates everything built on top. What are the cascading
effects, who bears the costs, and does the equilibrium hold?

**Key implications**:
- **Cascade depth = aggregation interval.** A trap invalidates all
  downstream chain blocks. Once a chain segment is aggregated, the
  aggregation serves as a checkpoint. Maximum cascade depth is bounded by
  aggregation frequency.
- **Verification pipeline doesn't help catch chain traps.** Verifying
  downstream blocks (state_3, state_4...) passes because they correctly
  computed from (wrong) inputs. Only sampling the trap block itself catches
  the fraud. Detection probability is unchanged from non-chain blocks.
- **Innocent chain publishers lose only opportunity cost**, not collateral.
  The trust module's non-canonical reclaim returns their stakes. Requesters
  bear the real cost (bounties for meaningless results).
- **Sampling module has a chain problem.** Descendant dampening
  deprioritizes blocks with many descendants — exactly where traps do the
  most damage. Chain descendants are mechanical continuations, not
  independent endorsements. Needs a chain-priority boost for chain head
  blocks.
- **Chain traps are more profitable** than non-chain traps (amplified
  jackpot from cascaded aggregator collateral), which shifts the
  equilibrium toward more fraud in chains and thus more verification.
  The self-correcting dynamic still holds.
- **Aggregators should verify chain blocks more thoroughly** before
  aggregating, due to amplified risk.
- **Parallel chain forks** provide instant recovery for critical chains
  (redundant computation by multiple responders) at the cost of double
  computation.

**Main risk**: The sampling module's descendant dampening actively works
against chain security. Without chain-aware priority boosting, trap blocks
in long chains become increasingly unlikely to be sampled. The equilibrium
adjustment (more fraud → more verification) may be too slow to prevent
significant cascade damage.

**Comparison positioning**: Extends E2's independent-block analysis to
chains. E4 introduced chains without analyzing cascade dynamics. E5
proposed phased prototyping; this exploration argues Phase 2 (computation
chains) should include chain-aware sampling from the start. Identifies
aggregation as natural checkpointing (no separate mechanism needed).

---

### 7. Weight, Gas, and the Economics of Computation ([details](explorations/07-weight-gas-and-economics.md))

**Direction**: Work through how gas/instruction limits, weight, collateral,
bounties, and verification costs interact to form a coherent economic model.
E5 flagged gas limits as critical; weight.md left the question open. This
exploration resolves it with concrete numbers and parameter derivations.

**Key implications**:
- **Hybrid weight model**: `consensus_weight = computation_weight +
  economic_throughput × WEIGHT_PER_VALUE`. Only the computation component
  determines the gas budget. Economic weight is structurally verifiable
  and doesn't need the deception game. This solves the tension between
  computation-heavy/low-value blocks (games) and value-heavy/low-computation
  blocks (transfers).
- **Collateral-backed weight prevents the easy trick attack** for the
  economic dimension. With program-as-contract, shortcuts within the same
  WASM binary don't exist (deterministic execution), further reducing the
  attack surface.
- **The claiming limit N is the key lever** for the deception game
  equilibrium. j/c = N/COLLATERAL_PER_WEIGHT. For a 99% catch rate
  equilibrium, N ≈ 1,000 with COLLATERAL_PER_WEIGHT = 10.
- **Verified weight should use actual gas consumed**, not declared weight.
  This prevents weight inflation through gas overpayment. The sampling
  module naturally observes actual gas during re-execution:
  `verified_weight = (actual_gas / gas_limit) × declaredWeight`.
- **Verification cost should be dampened** in sampling priority using
  `sqrt(verification_cost)` to prevent expensive blocks from being
  systematically under-sampled while still biasing toward cheap verification.
- **Multi-input computation** (game ticks consuming player moves + previous
  state) naturally solves bounty sustainability. Players fund computation
  by providing valued inputs.

**Main risk**: The j/c ratio is determined by protocol constants
(N/COLLATERAL_PER_WEIGHT), not by market dynamics. Choosing N requires
balancing verifier incentives against aggregator risk exposure. N = 1,000
gives a 99% catch rate but means each fraud event can claim 1,000× the
block's weight in aggregator collateral.

**Comparison positioning**: Resolves weight.md's open question in favor
of a hybrid model (closest to Option D). Grounds E2's abstract deception
game parameters in concrete protocol constants. Validates E5's
"declaredWeight = gas budget" proposal but adds the hybrid model and
verified-weight-from-actual-gas mechanism as necessary additions.

---

### 8. Contract Versioning, State Migration, and Cross-Contract Composition ([details](explorations/08-contract-versioning-and-composition.md))

**Direction**: Address E4's flagged risk — when program hash = contract,
upgrading the program changes the contract, breaking UTXO chains. Also
analyze how different computation contracts compose through multi-input
claims.

**Key implications**:
- **Versioning is solvable without breaking program-as-contract.**
  Developers include a FINALIZE mode that produces a MIGRATION_READY
  output. A migration block transforms state from old contract to new.
  The protocol provides MIGRATION_READY as a standard contract.
- **Immutability is a feature, not a limitation.** Contracts without
  migration paths are permanently locked. This provides strong guarantees
  about rule stability. Upgradeability is opt-in and explicit.
- **Cross-contract composition works through multi-input claims.** A
  block claiming outputs from multiple contracts satisfies each spending
  condition independently. No internal contract calls — all dependencies
  are explicit in block structure.
- **Four composition patterns** cover common cases: sequential pipeline
  (A→B→C), fan-in aggregation (A+B+C→D), fan-out distribution (A→B+C+D),
  and bidirectional communication (two chains synchronizing periodically).
- **Proxy contracts rejected.** Indirection layers break program-as-
  contract, create non-deterministic verification, and add trust chain
  complexity. Explicit migration is simpler and more transparent.
- **Application-level identity** (contract registries, metadata exports
  like NAME/VERSION/AUTHOR) maps human-readable names to contract hashes.
  The protocol doesn't need a naming system.

**Main risk**: Contracts not designed with FINALIZE mode cannot be
upgraded — their state is permanently locked. This is by design but
requires developer foresight. Also, multi-contract blocks run multiple
verification passes (one per claimed contract), which increases
verification cost.

**Comparison positioning**: Resolves E4's flagged versioning risk. Shows
that program-as-contract's immutability is analogous to Ethereum's
unupgradeable contracts but simpler (no proxy patterns, no delegatecall,
no storage collisions). Generalizes E7's multi-input computation to
cross-contract composition.

---

### 9. The Developer Experience and SDK Design ([details](explorations/09-developer-experience-and-sdk.md))

**Direction**: Walk through the end-to-end developer workflow for building
computation contracts. What SDK and tooling does the protocol need? What
does writing, testing, deploying, and debugging a contract actually look
like?

**Key implications**:
- **The SDK is thin.** A Rust crate (`scaffold_sdk`) providing
  `ComputeContext`, host bindings, and a `#[scaffold_compute]` macro.
  The WASM export interface is simple enough for other languages to
  target directly. Developers write `compute()`, everything else is
  generated.
- **Determinism is the main developer concern.** No floats (use
  fixed-point), no HashMaps (use BTreeMap), no system calls. The SDK
  provides deterministic alternatives and the build system can lint for
  non-deterministic patterns.
- **Testing is local-first.** Unit tests run WASM against a mock host
  with no network. `scaffold devnet` simulates multi-node behavior
  locally. Integration testing with deception simulation validates the
  full protocol stack.
- **The block explorer integrates via contract-as-explorer** (output-
  data.md's list/read/type). Any contract exporting these functions gets
  automatic tree-view rendering. Rich renderers (2D grid, table) are
  available for contracts that declare render hints.
- **Gas is invisible until you hit it.** `scaffold profile` shows
  instruction breakdown by function. Developers optimize only when
  needed.
- **Development lifecycle matches prototype phases.** Phase 1 needs:
  SDK crate, build, test, publish. Each subsequent phase adds CLI
  commands and SDK capabilities incrementally.

**Main risk**: WASM determinism across browsers/runtimes is the biggest
practical risk. Floating-point behavior varies across platforms. The
SDK must ban floats and provide fixed-point alternatives, but developers
can still introduce non-determinism through unsafe patterns.

**Comparison positioning**: Complements all prior explorations by showing
the developer-facing surface. Validates E4's minimal WASM interface
(thin SDK), E5's phased prototyping (each phase has matching tooling),
E7's gas model (invisible to developers), and E8's migration (CLI
command). Compared to Ethereum's DX (Solidity → Hardhat → ethers.js →
Etherscan), Scaffold's is simpler: no ABI layer, no deployment
transaction, re-execution IS verification.

---

### 10. Final Synthesis and Design Specification ([details](explorations/10-final-synthesis.md))

**Direction**: Consolidate E1–E9 into a single actionable design
specification. State each decision, its rationale, and remaining open
questions. Intended as a document someone could use to start implementing.

**Key implications**:
- **Three pillars**: (1) program-as-contract (WASM hash = contract),
  (2) deception game (insurance + self-catch), (3) challenge-response
  for offline state. Everything else supports these.
- **4 new standard contracts**: INSURANCE, CHALLENGE, QUERY,
  MIGRATION_READY. Plus any application WASM. The existing Computation
  contract is subsumed by program-as-contract.
- **Concrete protocol parameters**: INSTRUCTIONS_PER_WEIGHT_UNIT = 1M,
  COLLATERAL_PER_WEIGHT = 10, N = 1,000 (yields j/c = 100, catch
  rate ≈ 99%).
- **Module changes are minimal**: Sampling gets chain-awareness and
  verification cost dampening. Gossip gets contract-hash routing.
  Trust gets insurance commitment recognition. Consensus and conflict
  are unchanged.
- **5 implementation phases** with matching tooling: program-as-contract
  → chains → deception game → offline state → explorer.
- **Explicit exclusions**: No governance, no token, no mandatory
  replication, no block schema changes, no complex voting.
- **Risk table** with severity ratings and mitigations for each
  identified risk across all explorations.

**Main risk**: This is a synthesis, so its risks are inherited from the
component explorations. The highest-severity risk remains WASM floating-
point non-determinism across platforms.

**Comparison positioning**: Not a new direction — a distillation of all
nine prior explorations into an implementable specification. Resolves
all open questions from E1–E9 or explicitly defers them with rationale.

---

## Cross-Cutting Observations

All ten explorations converge on several points:

1. **No block schema changes** — everything fits in contracts/outputs.
2. **Three independent verification paths**: computation (re-execute),
   oracle data (check independently), offline state (challenge-response).
3. **The deception game applies differently by verification cost**:
   strong MITM protection for expensive computation, weak for cheap
   verification, moderate for offline state.
4. **The trust module's FOR/AGAINST collateral** is the foundation for
   all dispute resolution. New contracts (insurance, challenges) extend
   it without replacing it.
5. **Legacy2's complex voting hierarchy is unnecessary** when verification
   is deterministic (re-execute WASM, validate merkle proof).
6. **Program as contract** (E4) is the simplest unifying abstraction.
   The computation program IS the spending condition, creating
   self-perpetuating computation chains through UTXO claims.
7. **Gas limits tie weight to computation** (E5). `declaredWeight`
   determines the instruction budget, preventing both computation bombs
   and weight inflation.
8. **Simplify aggressively** (E5). Oracle logs and two-stage commitments
   are deferrable complexity. The core design works without them.
9. **Chain traps amplify damage but are bounded** (E6). Aggregation serves
   as natural checkpointing. The sampling module needs chain-awareness to
   counteract descendant dampening for chain head blocks.
10. **Hybrid weight model** (E7). Consensus weight combines computation
    weight (gas-derived) and economic throughput. Only computation weight
    determines the gas budget. Verified weight uses actual gas consumed,
    not declared weight, preventing inflation.
11. **Versioning through explicit migration** (E8). Program-as-contract's
    immutability is a feature. Upgradeable contracts opt in via FINALIZE
    mode + MIGRATION_READY. Cross-contract composition uses multi-input
    claims, not internal calls.
12. **Thin SDK, local-first testing** (E9). Developers write `compute()`,
    everything else is generated. Determinism is the main concern (no
    floats, no HashMaps). Testing runs locally against mock hosts.
13. **The design is implementable** (E10). Three pillars (program-as-
    contract, deception game, challenge-response), 4 new standard
    contracts, minimal module changes, 5 phased implementation steps,
    concrete protocol parameters.
