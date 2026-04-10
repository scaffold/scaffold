# Scaffold Launch Roadmap

Last updated: 2026-04-03

## Phase 1: Testnet

### M1: P2P Network (Apr 7 -- May 9)

Two nodes can discover each other, sync blocks, and gossip.

- [x] Wire NetworkManager -> Coordinator (incoming blocks -> consensus pipeline)
- [x] Wire gossip push actions -> NetworkManager send, respecting bandwidth budgets and immediate/deferred flags
- [x] Register PeerConnection handlers: onSync, onRequest, onDelivery, onPeerInfo
- [ ] Block fetching in SyncProtocol: recursive ancestor fetch, request batching, timeout/retry with peer rotation
- [x] WebRTC signaling exchanged over WebSocket bootstrap connections
- [x] Basic peer lifecycle: connect, disconnect, reconnect, bootstrap address list
- [ ] Integration tests: multi-node sync over WebSocket, browser-to-browser over WebRTC

### M2: Trust & Verification Automation (May 12 -- Jun 20)

The economic layer runs autonomously -- nodes verify, stake, and litigate.

- [ ] Collateral posting: new CollateralStrategy that creates blocks with FOR outputs on blocks we publish, AGAINST outputs when verification fails
- [ ] Insurance on aggregation: wire aggregation flow to emit insurance outputs (InsuranceContract posting side)
- [ ] Aggregation claim mask commitment: merkle root of the ordered claimed-index set, committed in aggregation block data
- [ ] Auto verification: SamplingStrategy wired to real JS contract execution (not just probe selection), configurable via enableVerification
- [ ] Auto litigation: when verification succeeds post FOR collateral, when it fails post AGAINST. Wire DisputeStrategy to create actual collateral output blocks, not just emit actions
- [ ] Reactive re-verification: when AGAINST collateral is observed on any block, trigger verification of that block (new reactive trigger)
- [ ] Balance query contract: request output asks "what are my unspent outputs for verifier X?", any node with the data responds via standard incentive/response pattern
- [ ] Tests for each: collateral lifecycle, insurance lifecycle, litigation triggers, balance queries

### M3: SDK & Testnet Launch (Jun 23 -- Jul 25)

Developers can build apps. Testnet goes live for friends and engineers.

**SDK (weeks 1-2):**
- [ ] Scaffold.ts: proper start/stop lifecycle, connection management, error events
- [ ] scaffold.fetch() end-to-end over network (request -> peer resolves -> response returns)
- [ ] scaffold.put() publishes and gossips
- [ ] JS contract registration API
- [ ] 3 example contracts (key-value store, counter, simple game state)
- [ ] "Build your first app" tutorial

**Testnet infrastructure (weeks 3-4):**
- [ ] 2-3 bootstrap nodes on cloud VMs
- [ ] Testnet genesis with initial distribution
- [ ] Browser demo app running against live testnet
- [ ] Basic network health dashboard (block rate, peer count, conflict rate)
- [ ] Stress test: 10+ nodes, sustained block creation + conflict resolution + aggregation
- [ ] Known-issues doc (what's not secure, what's missing for mainnet)
- [ ] Distribute to friends/engineers, collect feedback

**Testnet launch: ~Jul 25, 2026**

---

## Phase 2: Mainnet

### M4: WASM Contract Runtime (Jul 28 -- Sep 12)

Third-party contracts run as WASM with full sandboxing.

- [ ] WebAssembly.instantiate integration in ExecutionModule
- [ ] Host function bindings: ContractEnv imports (requireResult, requireOutput, fetch, collectInputs)
- [ ] WasmStore: load, cache, serve WASM binaries from the network
- [ ] Real Generator replacing StubGenerator (GeneratingEnv -> WASM execution)
- [ ] Resource limits: instruction metering, memory caps, execution timeout
- [ ] Determinism enforcement: no WASI, no randomness, no time, no floating point non-determinism
- [ ] Contract deployment workflow: compile -> publish -> reference by hash
- [ ] Port core contracts to WASM (signature, aggregation, collateral)
- [ ] Determinism test: same contract, different nodes, identical output

### M5: Security Hardening (Sep 15 -- Oct 24)

Close the 4 open attacks. Harden for adversarial conditions.

- [ ] Gossip rate limiting + congestion control (closes gossip flooding)
- [ ] Peer diversity mechanism + anti-eclipse (closes eclipse attack)
- [ ] Peer scoring system based on gossip quality metrics (closes sybil peers)
- [ ] Bootstrap trust mechanism (closes ghost chain)
- [ ] Collateral decay constant calibration
- [ ] Claiming limit parameter N calibration
- [ ] Review all 40 attacks from attacks.md against actual implementation
- [ ] Penetration testing pass on network layer

### M6: AI-Adversarial Testing (Oct 27 -- Jan 9, 2027)

AI tries to break the protocol. 4+ week clean soak before mainnet.

**Setup (weeks 1-4):**
- [ ] Docker Compose test network with N honest nodes
- [ ] Orchestrator: seed balances, continuous invariant monitoring, full block recording
- [ ] Chaos injection: network delays, partitions, node crashes
- [ ] Adversary agent: LLM with tool access (create_block, post_collateral, withhold_block, selective gossip, etc.)
- [ ] Multiple agent profiles: conservative, aggressive, collusion-focused

**Campaigns (weeks 5-8):**
- [ ] First campaign: 1 adversary vs 5 honest, 24-hour run
- [ ] Fix discovered issues, add attack traces to test suite
- [ ] Extended campaign: 1-2 week continuous run
- [ ] Vary parameters: adversary CPU budget, starting balance, number of honest nodes

**Soak (weeks 8-11):**
- [ ] 4+ weeks of continuous adversarial runs with no protocol-breaking findings
- [ ] Any finding resets the soak clock

### M7: Mainnet Launch (Jan 12 -- Jan 30, 2027)

Production network goes live.

- [ ] Mainnet genesis (new keys, production distribution)
- [ ] Production bootstrap nodes (geographically distributed)
- [ ] SDK v1.0 with WASM contract support
- [ ] Landing page: code snippet front-and-center, "Move your cloud to your client"
- [ ] Updated getting-started for mainnet
- [ ] 2-3 demo apps: simple API, real-time game, content feed
- [ ] HN post, dev Twitter, Discord/community outreach
- [ ] Monitoring + alerting for network health

**Mainnet launch: ~late Jan 2027**

---

## Timeline

```
2026
Apr        May        Jun        Jul        Aug        Sep        Oct        Nov        Dec        Jan 2027
|----------|----------|----------|----------|----------|----------|----------|----------|----------|---------|
 M1:P2P     ===M2:Trust/Verify===  M3:SDK     ====M4:WASM Runtime====  M5:Security  ===M6:AI-Adversarial===
 Network                           +Testnet                             Hardening     Testing (4wk soak) M7
                                   LAUNCH                                                              MAINNET
```

## Key Risk

The biggest schedule risk is M6. If the AI adversary finds a protocol-level issue late in the soak period, the soak clock resets. This is by design -- the mainnet must not need relaunching. Budget for a potential 1-2 month slip if adversarial testing surfaces something fundamental.
