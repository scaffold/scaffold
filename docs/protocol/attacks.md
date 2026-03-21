# Attack Catalog

This document catalogs known attacks against the Scaffold protocol, organized by the attacker's goal. Each entry describes the attack, the defense (if any), its current status, and links to relevant specs or tests.

**Status key**:
- Defended: The protocol has a structural defense. Link to spec.
- Mitigated: The attack is bounded but not eliminated. Link to analysis.
- Open: No defense exists yet. Needs design work.
- By design: The attack is an intentional part of the protocol's equilibrium.

---

## Goal: Shift Consensus

Attacks that aim to make a non-canonical branch canonical, or to accumulate disproportionate consensus influence.

### 1. Majority Weight Attack (51%)

**Attack**: A coalition controlling >50% of the network's total verified weight can determine all conflict outcomes, making their preferred branch canonical regardless of other participants' work.

**Defense**: None -- this is the fundamental security assumption of weight-based consensus. The protocol assumes honest majority of verified weight.

**Status**: Mitigated (by economic cost). Each unit of weight costs the aggregation fee f ~= v. Acquiring 51% of weight requires paying 51% of total verification costs. See [weight.md](weight.md).

**Refs**: [consensus.md](consensus.md), [weight-design.md](weight-design.md) Attack Analysis.

---

### 2. Private Fork

**Attack**: Build a chain privately (no gossip), accumulating weight without competition. Publish once the private chain outweighs the public chain at the fork point.

**Defense**: Sampling. When the private fork is published, clients sample it proportionally to its declared throughput. The scaling factor `verification_cost / throughput` detects inflated weight. With pessimistic-pending (unverified blocks have zero effective weight), the private fork starts at zero and must be verified before it can win any conflict.

**Status**: Defended. See [sampling.md](sampling.md), [weight.md](weight.md).

**Refs**: [weight-design.md](weight-design.md) "Private Fork with Inflated Fees".

---

### 3. Deep Reorganization

**Attack**: Create a competing block at a deep anchor point (well-established chain position) and try to outweigh the honest block's descendants from that point onward.

**Defense**: The honest block has been accumulating descendant weight continuously. The attacker must match ALL descendant weight from the fork point onward, which grows over time. The cost is proportional to the honest chain's accumulated work.

**Status**: Defended (by economic cost). See [consensus.md](consensus.md).

---

### 4. Weight Cycling / Wash Trading

**Attack**: Cycle the same capital through contracts repeatedly, earning weight each cycle without genuine economic demand.

**Defense**: Each cycle pays the aggregation fee f ~= v. Weight per cycle = v = cost per cycle. Cycling is indistinguishable from legitimate computation (each cycle requires real contract execution). The aggregation fee prevents "free" cycling.

**Status**: Defended. See [weight.md](weight.md) "Why No Work Formula Is Needed".

---

### 5. Asymmetric Difficulty (Shortcut Contract)

**Attack**: Deploy a contract where the author knows a generation shortcut (e.g., a brute-forceable signature where the author holds the key). Produce blocks cheaply while verification remains expensive.

**Defense**: The aggregation fee f ~= v. The shortcut reduces generation cost but not the fee. Maximum advantage: ~2x capital efficiency (attacker pays ~v, honest pays ~2v). The whitelist is not needed because the fee mechanism bounds the advantage.

**Status**: Mitigated (~2x bounded advantage). See [weight-design.md](weight-design.md) "Asymmetric Difficulty".

---

### 6. Tree Duplication

**Attack**: Take a tree of legitimately computed work, re-sign every block and re-aggregate, producing N copies that appear as independent work.

**Defense**: Each copy requires its own aggregation fee (f ~= v per block) and collateral (M * C per block). Weight = N * v, cost = N * v. No amplification. Additionally, if duplicate blocks claim the same outputs as originals, they create conflicts -- only one copy can be canonical.

**Status**: Defended. See [weight.md](weight.md) "Duplication Defense".

---

### 7. Ref Duplication

**Attack**: Multiple blocks ref the same state (read-only reference) and perform the same computation. Each block is independently valid and earns full verification cost, but the attacker only computed the answer once.

**Defense**: Each duplicate still pays its own aggregation fee f ~= v. Weight = N * v, cost = N * v. No free amplification. The verification cost reflects the burden imposed on the network (each block must be independently verified), and the attacker pays for that burden.

**Status**: Defended (by aggregation fee). See [weight-design.md](weight-design.md) "Tree Duplication".

---

### 8. Trivial Contract Spam

**Attack**: Produce millions of blocks on trivially cheap contracts, hoping to accumulate weight through volume.

**Defense**: Trivial contract means v ~= 0, so weight ~= 0 per block. Each block still requires collateral M * C. The attacker pays significant capital for negligible weight.

**Status**: Defended. See [weight-design.md](weight-design.md) "Trivial Contract Spam".

---

### 9. Capital Dominance

**Attack**: A wealthy participant uses large-value outputs to earn disproportionate weight, since they can fund more blocks.

**Defense**: Weight = verification cost, which doesn't scale with input values. Processing 1M through a trivial contract earns the same weight as processing 1. Capital bounds total participation (via aggregation fees and collateral) but doesn't provide a per-block advantage.

**Status**: Mitigated. The system is a hybrid of computation (v) and capital (fees/collateral). See [weight-design.md](weight-design.md) "Capital Dominance".

---

### 10. Ghost Chain (Bootstrapping)

**Attack**: Early in the network's life, total weight is low. An attacker creates a competing chain with modest computation that matches or exceeds the honest chain's weight. Double-spend across the two chains.

**Defense**: None structural. During bootstrapping, the network must rely on out-of-band trust (trusted initial participants, checkpoints).

**Status**: Open. Bootstrapping trust mechanism not yet specified.

---

### 11. Slow Weight Accumulation

**Attack**: Participate honestly for months, building descendant weight on a chain segment. Then create a competing block at that depth with a privately-built fork, attempting a deep reorg.

**Defense**: The private fork must accumulate more weight than the honest chain has accumulated since the fork point. This cost grows linearly with time. Sampling detects any inflation in the private fork.

**Status**: Defended (by economic cost growth over time).

---

## Goal: Pass Invalid Computation

Attacks that aim to get incorrect computation results accepted as canonical.

### 12. Publishing Invalid Blocks

**Attack**: Publish a block with incorrect computation results, hoping no one verifies it.

**Defense**: The deception equilibrium. Aggregators verify a fraction q of blocks. Independent verifiers sample post-aggregation. The bounty for catching fraud (alpha * M * C) far exceeds the verification cost v, making independent verification profitable.

**Status**: Defended. See [deception.md](deception.md).

---

### 13. Lazy Aggregator

**Attack**: An aggregator accepts blocks without verifying them to save computation costs. Invalid blocks slip through.

**Defense**: The deception equilibrium. If the aggregator doesn't verify, deceptive publishers self-flag and claim the aggregator's collateral M * C. The aggregator loses more from unverified invalid blocks than they save by skipping verification. The equilibrium verification rate q makes both strategies (verify / don't verify) equally profitable.

**Status**: Defended (by design). See [deception.md](deception.md) "Nash Equilibrium".

---

### 14. Strategic Deception (Self-Flagging)

**Attack**: Publish an invalid block, wait for an aggregator to take on risk, then self-flag to claim alpha * M * C from the aggregator's collateral.

**Defense**: This is **by design**. The self-flagging incentive funds the verification layer. At equilibrium, deception is equally profitable as honest work but with higher variance. Risk-averse publishers prefer honest behavior. The fraud rate stabilizes at p = v / (M * C).

**Status**: By design. See [deception.md](deception.md) "The Deception Equilibrium".

---

### 15. Malicious Fraud (No Self-Flag)

**Attack**: Publish invalid blocks hoping they persist in the canonical state. Unlike strategic deception, the attacker does NOT self-flag -- they want the invalid state to survive.

**Defense**: Aggregator probing catches a fraction q of blocks. Independent verifiers sample post-aggregation for bounty alpha * M * C. Application-layer users notice incorrect state. Other publishers whose blocks depend on the fraudulent block's outputs eventually detect inconsistency.

**Status**: Defended (probabilistically). As long as alpha * M * C >> v, malicious fraud is eventually caught with high probability. See [deception.md](deception.md) "Malicious vs. Strategic Fraud".

---

### 16. Aggregator Cache Poisoning

**Attack**: An aggregation block declares incorrect cache contents (wrong claim masks, wrong weight vectors) while producing a structurally valid block.

**Defense**: The aggregation contract's verifier checks cache correctness structurally. Sampling re-executes the aggregation verifier, catching incorrect caches. The aggregator's collateral is at risk if the cache is wrong.

**Status**: Defended. See [aggregation.md](aggregation.md), [computation.md](computation.md).

---

## Goal: Double Spend

Attacks that aim to spend the same output twice.

### 17. Direct Double Spend

**Attack**: Create two blocks that both claim the same output.

**Defense**: Conflict detection. The OutputClaimModule detects when two blocks claim the same output and fires a conflict. Consensus resolves the conflict by effective weight -- only one block becomes canonical.

**Status**: Defended. See [conflict.md](conflict.md), [output-claims.md](output-claims.md).

**Tests**: `tests/network/conflict.test.ts` -- same-anchor conflicts, three-way conflicts, weight-based resolution.

---

### 18. Cross-Subtree Double Spend

**Attack**: Two blocks in different subtrees of an aggregation both claim the same anchor-level output. If aggregated together, both claims would be honored.

**Defense**: Inter-subtree conflict detection during aggregation. The BlockCreationModule uses exclusive rebased claim masks to detect overlapping anchor claims across subtrees. Aggregation blocks with inter-subtree conflicts are rejected.

**Status**: Defended. See [block-creation.md](block-creation.md).

**Refs**: `src/core/BlockCreationModule.ts` lines 206-227.

---

### 19. Equivocation

**Attack**: Present different conflicting blocks to different peers simultaneously. Peer A sees block B1 claiming output O, peer B sees block B2 claiming the same output O. If the attacker can partition the network, each peer accepts a different version.

**Defense**: Gossip propagation. Eventually both blocks reach both peers, and the conflict is detected. The conflict is resolved by effective weight. The equivocation itself is detectable (same creator, same anchor, different content) and could be used as evidence for reputation penalties.

**Status**: Partially defended (gossip convergence). No explicit equivocation penalty yet.

---

### 20. Race Condition Double Spend

**Attack**: Publish two conflicting blocks nearly simultaneously, hoping that each propagates to different parts of the network and gets built on before the conflict is detected.

**Defense**: Conflict detection is local and immediate -- as soon as a node sees both blocks, it detects the conflict. Consensus resolves by effective weight. The pessimistic-pending model means neither block has effective weight until verified, preventing premature commitment.

**Status**: Defended. See [consensus.md](consensus.md), [sampling.md](sampling.md).

---

## Goal: Denial of Service

Attacks that aim to degrade network performance or prevent honest participants from operating.

### 21. Aggregation Delay / Starvation

**Attack**: Prevent or delay aggregation of competitors' subtrees by claiming aggregation outputs before honest aggregators and never completing the aggregation, or by producing minimal-effort aggregation blocks.

**Defense**: Conflict resolution. The attacker's empty/stalled aggregation block has zero descendants and loses the conflict to an honest aggregator's block that has more descendant weight. The delay is temporary.

**Status**: Partially defended. The attacker can cause transient delays but cannot permanently block aggregation. The economic cost (collateral locked on stalled blocks) limits the duration.

---

### 22. Verification Cost Inflation

**Attack**: Deploy a contract with deliberately inflated verification cost (unnecessary busy-work in the verifier). Force the network to spend disproportionate resources verifying trivial blocks.

**Defense**: The attacker pays f ~= v for each block. If v is high, the fee is high. Aggregators choose which blocks to aggregate -- they won't aggregate blocks with disproportionately expensive verification unless compensated. The market self-corrects.

**Status**: Mitigated (by market pricing). Aggregators can refuse to aggregate prohibitively expensive blocks.

---

### 23. Block Spam

**Attack**: Flood the network with large numbers of low-value blocks, consuming gossip bandwidth, storage, and processing.

**Defense**: Each block requires collateral M * C. The attacker must lock significant capital to produce many blocks. Gossip scoring can deprioritize low-value or suspicious blocks. Nodes can set minimum weight thresholds for blocks they process.

**Status**: Partially defended. Collateral requirement limits volume. Gossip-layer filtering is not yet specified.

---

### 24. Gossip Flooding

**Attack**: Send excessive gossip messages (block announcements, peer requests) to overwhelm a peer's bandwidth or processing.

**Defense**: Rate limiting, peer scoring, and connection management in the gossip module. Peers that consistently send low-quality or excessive messages are deprioritized or disconnected.

**Status**: Open. Gossip rate limiting not yet specified. See [gossip.md](gossip.md).

---

## Goal: Influence Peer View

Attacks that aim to manipulate what a specific peer sees, rather than what the network as a whole believes.

### 25. Eclipse Attack

**Attack**: Surround a target peer with attacker-controlled nodes, controlling all information the peer receives. Feed the peer a false view of the network (attacker's chain, suppressing honest blocks).

**Defense**: Peer diversity requirements. The gossip module should maintain connections to diverse peers (different IP ranges, different geographic regions). Peers should validate that their view is consistent (e.g., by connecting to known bootstrap nodes periodically).

**Status**: Open. Peer diversity and anti-eclipse mechanisms not yet specified in [gossip.md](gossip.md).

---

### 26. Selective Block Withholding

**Attack**: An attacker relays most blocks but withholds specific blocks from a target peer, giving the target an incomplete view that might cause them to make incorrect conflict resolution decisions.

**Defense**: Redundant gossip paths. Blocks should be received from multiple peers. If a block is referenced (as anchor or aggregate) but not yet received, the peer can request it from other peers. The anchor/aggregate structure makes missing blocks detectable -- you can't process a block whose anchor you haven't seen.

**Status**: Partially defended. Block fetching on reference is structural. Active anti-withholding is not yet specified.

---

### 27. Sybil Gossip Peers

**Attack**: Create many fake identities (sybil peers) to dominate a target's peer set, enabling eclipse attacks or gossip manipulation.

**Defense**: Peer scoring based on the quality of blocks provided (valid blocks, novel blocks, timely delivery). Sybil peers that don't provide genuine value are deprioritized. Connection limits and diversity requirements reduce sybil effectiveness.

**Status**: Open. Peer scoring system not yet specified. See [gossip.md](gossip.md).

---

## Goal: Extract Disproportionate Value

Attacks that aim to extract more economic value than the attacker's fair share of work.

### 28. Front-Running (MEV)

**Attack**: Observe a pending request in the gossip layer, immediately compute the result, and publish a block claiming the output before the intended service provider. The attacker captures the fee that was intended for the honest provider.

**Defense**: No protocol-level defense. This is a natural consequence of permissionless competition. Users can mitigate by specifying preferred providers in their requests (e.g., requiring a specific signer) or by using private channels for request submission.

**Status**: Open (by design). Permissionless competition implies front-running is possible. Application-layer mitigations exist but are not protocol-enforced.

---

### 29. Aggregation Monopoly

**Attack**: A single aggregator processes all blocks in a region of the tree, facing no competition. Without competition, they can charge above-market fees and selectively include/exclude blocks.

**Defense**: Aggregation is permissionless -- anyone can aggregate. If the monopolist charges high fees, competing aggregators enter. Block-level conflicts mean the monopolist's aggregation block can be challenged by a more efficient aggregator.

**Status**: Mitigated (by permissionless entry). In low-activity regions, temporary monopolies may exist but are self-correcting.

---

### 30. Self-Flagging Profit Optimization

**Attack**: A sophisticated operator mixes honest and deceptive blocks, optimizing the ratio to maximize total profit from both honest rewards and self-flagging proceeds.

**Defense**: By design. The equilibrium makes deception equally profitable as honest work (in expectation) with higher variance. The optimal strategy is honest publishing for risk-averse operators. The equilibrium fraud rate p is protocol-controlled via M and C.

**Status**: By design. See [deception.md](deception.md).

---

### 31. Verification Cartel

**Attack**: A verifier and publisher collude. The publisher tips off the verifier about which blocks are invalid, they split the flagging reward, avoiding the risk of the publisher losing collateral.

**Defense**: Not clearly harmful. The collateral is still claimed, the invalid block is still detected, and the verification layer still functions. The "victim" is the aggregator who should have probed more carefully. The collusion effectively increases the detection rate, which is beneficial.

**Status**: Mitigated (collusion may actually help the system). See [deception.md](deception.md) Open Question 4.

---

## Goal: Circumvent Collateral / Trust

Attacks that aim to avoid collateral penalties or exploit the trust system.

### 32. Circular Trust

**Attack**: Post collateral on a block B using a collateral block C that is a descendant of B. If B is invalidated, C (the collateral) would also be invalidated, making the collateral worthless at exactly the moment it's needed.

**Defense**: The TrustModule enforces a no-circular-trust invariant: collateral block C must not be a descendant of target block B. This is checked at collateral placement time.

**Status**: Defended. See [trust.md](trust.md).

**Refs**: `src/core/TrustModule.ts` line 143.

**Tests**: `tests/network/trust.test.ts` -- circular trust rejection.

---

### 33. Collateral Decay Exploitation

**Attack**: Exploit the decreasing collateral multiplier M over time. Wait until M is very low (block has been re-aggregated several times), then flag the block when the penalty is minimal.

**Defense**: The floor for M is bounded by alpha * M * C > v (independent verification must remain profitable). Below this floor, M cannot decrease further. The protocol sets a minimum M.

**Status**: Mitigated. See [deception.md](deception.md) "Collateral Decay", Open Question 1.

---

### 34. Claim Limit Overflow

**Attack**: Attempt to claim more collateral than the encapsulated weight justifies, extracting disproportionate penalties from an aggregator.

**Defense**: The TrustModule enforces a claim limit: `claim_limit = encapsulated_weight * multiplier`. Claims exceeding this limit are rejected. The encapsulated weight is computed from the block's actual contribution, preventing the aggregator from being penalized beyond what the block's weight justifies.

**Status**: Defended. See [trust.md](trust.md).

**Refs**: `src/core/TrustModule.ts` lines 294-317.

---

### 35. Collateral-Free Publishing

**Attack**: Publish blocks without posting collateral, avoiding all economic risk.

**Defense**: Blocks without collateral are not aggregated (aggregators won't take on risk for uncollaterlized blocks). Unaggregated blocks don't participate in consensus. The block exists but has no influence.

**Status**: Defended (by aggregation requirement). See [deception.md](deception.md) "Risk Transfer".

---

## Goal: Exploit Contract / Computation

Attacks targeting the contract execution or verification layer.

### 36. Non-Deterministic Contract

**Attack**: Deploy a contract whose execution depends on external state (time, randomness, network calls), causing different verifiers to get different results. This makes verification unreliable and dispute resolution ambiguous.

**Defense**: Contracts run in deterministic WASM environments. External state is not accessible. The execution environment provides only the block's own data (claims, refs, outputs) as input. Non-determinism is structurally prevented.

**Status**: Defended. See [computation.md](computation.md), [verification.md](verification.md).

---

### 37. Resource Exhaustion Contract

**Attack**: Deploy a contract that consumes excessive memory, CPU, or stack depth during verification, causing verifier crashes or hangs.

**Defense**: WASM execution environments support resource limits (gas metering, memory caps, stack depth limits). Contracts exceeding limits are terminated and the block fails verification.

**Status**: Partially defended. Resource limits are a WASM runtime concern. Protocol-level gas metering not yet specified.

---

### 38. Claim Index Manipulation

**Attack**: Craft a block with claim indices that are negative, out of range, or pointing to unexpected outputs in the extended vector.

**Defense**: The BlockCreationModule validates claim indices at construction time: negative indices are rejected, out-of-range indices are rejected. The output-space construction ensures the extended vector is well-defined before claims are applied.

**Status**: Defended. See [block-creation.md](block-creation.md), [output-space.md](output-space.md).

**Refs**: `src/core/BlockCreationModule.ts` lines 236-250.

---

### 39. Throughput Imbalance

**Attack**: Create a block where total input value differs from total output value, violating conservation. This could create or destroy value.

**Defense**: The BlockCreationModule validates throughput balance: sum of input values must equal sum of output values. Blocks violating this invariant are rejected.

**Status**: Defended. See [block-creation.md](block-creation.md).

**Refs**: `src/core/BlockCreationModule.ts` line 252-253.

---

### 40. Signature Forgery

**Attack**: Forge a block's signature to impersonate another publisher, or claim a signature-protected output without holding the private key.

**Defense**: Packets are signed with secp256k1. Signature verification recovers the signer's public key and checks it against the expected key. The SignatureContract verifies that the claiming block is signed by the key specified in the output's verifier params.

**Status**: Defended (by cryptographic hardness of secp256k1).

**Refs**: `src/core/Packet.ts` lines 130-165, `src/core/SignatureContract.ts`.

---

## Summary Table

| # | Attack | Goal | Status | Defense |
|---|--------|------|--------|---------|
| 1 | Majority weight (51%) | Consensus | Mitigated | Economic cost |
| 2 | Private fork | Consensus | Defended | Sampling |
| 3 | Deep reorg | Consensus | Defended | Economic cost growth |
| 4 | Cycling / wash trading | Consensus | Defended | Aggregation fee |
| 5 | Asymmetric difficulty | Consensus | Mitigated | Aggregation fee (~2x bound) |
| 6 | Tree duplication | Consensus | Defended | Aggregation fee + conflicts |
| 7 | Ref duplication | Consensus | Defended | Aggregation fee |
| 8 | Trivial contract spam | Consensus | Defended | v ~= 0, collateral |
| 9 | Capital dominance | Consensus | Mitigated | v independent of value |
| 10 | Ghost chain (bootstrap) | Consensus | Open | Needs bootstrap trust |
| 11 | Slow weight accumulation | Consensus | Defended | Linear cost growth |
| 12 | Publishing invalid blocks | Invalid result | Defended | Deception equilibrium |
| 13 | Lazy aggregator | Invalid result | Defended | Self-flagging incentive |
| 14 | Strategic deception | Invalid result | By design | Equilibrium fraud rate |
| 15 | Malicious fraud | Invalid result | Defended | Independent verification bounty |
| 16 | Cache poisoning | Invalid result | Defended | Aggregation contract verifier |
| 17 | Direct double spend | Double spend | Defended | Conflict detection |
| 18 | Cross-subtree double spend | Double spend | Defended | Inter-subtree conflict masks |
| 19 | Equivocation | Double spend | Partial | Gossip convergence |
| 20 | Race condition double spend | Double spend | Defended | Pessimistic pending |
| 21 | Aggregation delay | DoS | Partial | Conflict resolution |
| 22 | Verification cost inflation | DoS | Mitigated | Market pricing |
| 23 | Block spam | DoS | Partial | Collateral requirement |
| 24 | Gossip flooding | DoS | Open | Rate limiting needed |
| 25 | Eclipse attack | Peer influence | Open | Peer diversity needed |
| 26 | Selective withholding | Peer influence | Partial | Redundant gossip |
| 27 | Sybil gossip peers | Peer influence | Open | Peer scoring needed |
| 28 | Front-running (MEV) | Value extraction | Open | Application-layer only |
| 29 | Aggregation monopoly | Value extraction | Mitigated | Permissionless entry |
| 30 | Self-flagging optimization | Value extraction | By design | Equilibrium |
| 31 | Verification cartel | Value extraction | Mitigated | Not clearly harmful |
| 32 | Circular trust | Circumvent trust | Defended | Ancestry check |
| 33 | Collateral decay exploit | Circumvent trust | Mitigated | Minimum M floor |
| 34 | Claim limit overflow | Circumvent trust | Defended | Encapsulated weight bound |
| 35 | Collateral-free publishing | Circumvent trust | Defended | Aggregation requirement |
| 36 | Non-deterministic contract | Exploit contract | Defended | Deterministic WASM |
| 37 | Resource exhaustion | Exploit contract | Partial | WASM limits (needs spec) |
| 38 | Claim index manipulation | Exploit contract | Defended | Index validation |
| 39 | Throughput imbalance | Exploit contract | Defended | Balance validation |
| 40 | Signature forgery | Exploit contract | Defended | secp256k1 |
