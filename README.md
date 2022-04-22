# The Sublime Cloud
_The future of the web is sublime_

## What is it?
Sublime is an alternative to AWS. It's a P2P network of browsers communicating over WebRTC, executing functions and generally helping each other out.

## Usage
```ts
sbl.get(QuestionService).getCanonical({
  contract_answer_hash: '[your contract hash here]',
  params: '[contract parameters here]',
}, (answer: Answer) => console.log(answer.data))
// TODO: Example that shows speed
```

## How?
- Contracts and generators are written in WebAssembly and placed onto the network.
- Executors compete to resolve requests first, and are rewarded for their effort.
- Verifiers monitor the network and play a game with the executors; both try to dupe the other, and are rewarded when they succeed.

## Design goals
- It's very fast. Low latency is the #1 design goal. There is very little overhead between the computation of a result and its optimistic availability to be used in another calculation.
- It's secure. Peers are incentivized to verify others’ results. Each result is signed with collateral, and consensus will progressively solidify trust in it. Incorrect results are flagged, voted on, penalized, and eventually eliminated from the graph.
- It's immutable. Executions are baked into the global block graph, establishing consensus.
- It's truly decentralized. Centralized APIs like Infura or Alchemy are not required to interact with the network, since browsers connect directly. Servers can help out with additional compute, but even they have to abide by the same rules.

## Features
- Write once, run everywhere. Sublime embraces WebAssembly as the future of computing.
- Automatic load balancing. Lambdas are executed on the global Sublime network, composed of both browsers and servers, easily mitigating load spikes.
- Microservices without the misery. Never worry about versioning again. Updates roll out atomically with zero downtime.
- Multilingual. Contracts can be written in Rust, C++, AssemblyScript, Ruby, or any language that compiles to WASM.

## Use cases
- Dynamic web hosting
- Content distribution
- Multiplayer gaming
- Image/video processing

## Development
```sh
# Clone
git clone git@github.com:SublimeNet/sublime.git
cd sublime

# Run formatter
deno fmt --config=deno.jsonc --watch

# Run linter
deno lint --config=deno.jsonc --watch

# Run tests
deno test --config=deno.jsonc --import-map=import_map.json --allow-all --seed=123 --trace-ops --watch tests/

# Run websocket server (required for initial P2P connection)
deno run --config=deno.jsonc --import-map=import_map.json --allow-all --watch server/main.ts

# Bundle js
deno bundle --config=deno.jsonc --import-map=import_map.json --watch app.tsx build/index.js

# Open in browser
open public/index.html
```
