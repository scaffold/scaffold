# Scaffold

## Purpose
Scaffold is a browser-first protocol architecture that moves cloud responsibilities to clients and enables global consensus in the browser.

Primary feature:
- In-browser transparent microtransactions: a browser requests data or global state, peers compete to resolve first, and correct work is rewarded.

## High-Level Overview
Scaffold is intended to support:
- Serverless game-state consensus (deterministic WASM + dispute/penalty mechanics)
- Social content distribution from peers with signatures and globally consistent latest-state resolution
- Distributed database semantics
- Decentralized marketplaces with escrow and protocol-level resolution/voting

## Goals
1. Browser-native operation:
Use WASM, WebRTC, and WebSockets. Server-side implementations may exist for performance, but should not have privileged protocol capabilities.

2. Fast request/response that is usually correct:
The common-case request path should be faster than traditional server round trips, often requiring only one WebRTC P2P round trip with immediate trust signals (for example via collateral).

3. Economic pressure toward correctness:
Incorrect responses should be eventually corrected, and publishing incorrect responses should be economically disadvantageous. Risk-averse users should have safety-oriented operating modes.

4. Eventual immutability:
Executions are eventually committed to a global block graph. Finalization should be delayed enough to allow verifiers to detect and challenge incorrect executions.

## Constraints
- Protocol design first, implementation second.
- Security and correctness are first-order priorities.
- Incentive/game-theory design must be explicit before code-level commitment.
- Documentation is the source of truth for protocol behavior.
- Most code in `src/` is reference material only; primarily look at `docs/protocol/` for the latest and greatest.
- Use `camelCase` for TypeScript properties and interface fields. `snake_case` is allowed in pseudocode/math notation inside docs.

## Ways of Working
Planning -> Documentation -> Testing -> Coding

### Planning
- Iterate directly with Joel until assumptions and tradeoffs are explicit.
- Proactively raise missing constraints, attack surfaces, and ambiguous incentives.
- Notion may be used as historical reference (read-only), but can be stale.
- Write durable decisions in repo markdown, not in Notion.

### Documentation
- Protocol documentation is the highest-priority artifact.
- Maintain living docs with full ownership: add/update/delete as needed to keep docs aligned with intended protocol behavior.
- Target: docs should be sufficient for a conforming implementation without relying on undocumented assumptions.

### Testing
- Favor state-machine and transition-based tests.
- Model node state + peer/user inputs -> output blocks and side effects.
- Use tests to lock in protocol invariants and regression boundaries before broad implementation.

### Coding
- Implement after protocol docs and tests define expected behavior.
- As much as possible, keep things very modular and encapsulated. Use providers to abstract away dependencies.
- For logical parts, don't use Context or assume anything about the BlockType except what you can access through the provider.
- Glue code using Context should be minimal; it's much more difficult to test.

## 4-Step Development Sequence
1. Build `docs/protocol/` as markdown documents covering protocol concepts and mechanics.
2. Write a skeleton in `scaffold/src/`. Create the classes and interfaces you're going to need.
3. Write tests around protocol/state transition behavior. You can run them like this: `deno test --allow-all tests/ModuleName.test.ts`
4. Implement and iterate with documentation and tests as the controlling spec, until you're satisfied with your implementation.
