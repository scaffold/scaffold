# Plan: WASM Contract Runtime

## Goal
Replace the TypeScript mock contract registry in ExecutionModule with real WebAssembly contract loading and execution.

## What Exists
- ExecutionModule uses `Map<HashPrimitive, ContractFn>` — TypeScript functions registered by hash
- WasmStore (src/core/WasmStore.ts) — in-memory binary store, stub ready for use
- ContractEnv interface defines the host functions contracts need
- VerifyingEnv and GeneratingEnv implement ContractEnv for both modes
- ContractFn type: `(env: ContractEnv) => MaybePromise<void>`

## What Needs to Be Done

1. **WASM host function bindings**: Define the WASM import object that maps ContractEnv methods to WASM-callable functions. The WASM contract calls `requireInput()`, `requireOutput()`, `requireResult()`, `fetch()`, `requireSignature()` etc. via imported functions.

2. **Memory management**: WASM linear memory for passing byte arrays (params, keys, values, details) between host and guest. Need a serialization convention for Input, Output, Verifier types.

3. **Contract loading**: `WasmStore.get(hash) → Uint8Array → WebAssembly.instantiate(binary, imports) → instance.exports.verify()` (or `.generate()` for generation mode).

4. **Fallback**: Keep the TypeScript mock registry as a fallback for testing. If a contract hash has a registered TypeScript function, use it. Otherwise, look up in WasmStore.

5. **Integration**: Wire WasmStore into ExecutionModule and ContractGenerator.

## Open Questions
See docs/questions.md — WASM ABI design, memory layout, async handling.
