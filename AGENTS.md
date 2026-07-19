# Scaffold

## Purpose

Scaffold is a browser-first protocol architecture that moves cloud responsibilities to clients and enables global consensus in the browser.

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

## Philosophy

- The elegant, simple solution is always the right one.
- The protocol documentation is always the source of truth. The implementation is just an implementation.
- Scaffold is decentralized, so every action must be incentivized.

## Docs

The documentation lives in docs/v2/ and is divided into 3 files:
1. whitepaper.md - documents the protocol at a high level; should capture all of the incentives and game theory but doesn't need to dive into implementation details too much.
2. scaffold.md - documents the user-visible interface; both the TypeScript API and the contract's WASM ABI should live here.
3. implementation.md - documents the architecture and data structures needed to implement a competitive peer that aligns with the incentives outlined in the whitepaper.

Don't be afraid to update documentation if needed, but check with me first, and if I give you the go-ahead remember to keep it concise. Don't add unnecessary details or examples.

## Coding

### Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Code offensively

Offensive programming is a software development philosophy that deals with software bugs by having the program fail fast and visibly, rather than attempting to hide or recover from them. The goal is to make bugs obvious during development and testing, under the assumption that unexpected internal errors should be fixed by the programmer, not tolerated by the running software.

Use `assert(expr: unknown, msg?: string): void` and `error(msg: string): never` from src/util/functional.ts judiciously to fail-fast on invalid input.

Use the logging system to log recoverable edge cases or notable situations.

The public scaffold API is an exception; we may want to be more lenient in that case.

### Never drop errors silently

Any path that catches an exception, drops a malformed input, or silently rejects a request SHOULD emit a log event. Default to `warn` for anything unexpected from outside the node (malformed peer input, failed connections, rejected handshakes) and `debug` for internal conditions that are expected but worth tracing (duplicate messages, deduplication hits, fallback paths). A silent `try { ... } catch { }` or `if (!valid) return;` without a log makes production debugging much harder later -- the cost of adding the log is trivial compared to the cost of not having it when you need it.

### Never Hack Around Bugs or Gaps

If a bug, missing feature, or design gap is preventing you from completing a task or making a test pass, **stop and ask Joel for direction**. Do NOT silently work around it, weaken an assertion, skip the problematic path, or paper over the symptom. A failing test that documents a real gap is more valuable than a passing test that hides a bug we could have fixed.

When you hit a gap, surface it explicitly and offer the options. Joel may want to:
- Mark the test as `ignore` if we aren't going to fix it soon.
- Accept a failing test that will pass later when we address the issue.
- Hack a fix for now and document a future v2 TODO to clean it up.
- Pause the main task so Joel can address the gap in another session, then resume work with it fixed.

In every case where you find a gap or bug -- whether you work around it under direction, ignore the test, or pause -- **notify Joel and add an entry to `TODO.v2.md`**. You have absolute freedom (and are expected) to autonomously add things you discover to `TODO.v2.md`. There should be no unreported gaps or bugs that Claude saw and worked around.

This is a team effort and Joel depends on you. Always strive for quality. If you see something, say something.
