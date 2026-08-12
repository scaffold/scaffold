# Scaffold.io

Scaffold moves the cloud to the client.

## What is it?

Scaffold is a protocol that runs in the browser and turns your users into infrastructure, connecting them to each other via WebRTC and providing a consensus layer supporting contract execution and micropayments. Write your contracts in WebAssembly, and Scaffold manages the rest.

## What is it not?

Scaffold is not a blockchain. It is not designed for fast consensus; in fact the opposite is desirable in many cases - in order to use blocks optimistically, before we've been able to verify them, we need to be able to easily re-write the graph if they're incorrect.

Scaffold is not a cryptocurrency. While it does use coins, due to the slow consensus, they aren't useful for large transactions. The small transactions used for incentivizing computation are the perfect use case.

## Usage

```ts
const scaffold = new Scaffold({
  ...makeDefaultConfig(),
  roles: [GeneratorRole],
});

scaffold.startTransport(new WebsocketClientTransport());
scaffold.connect("ws://127.0.0.1:8314/");

const params = await scaffold.serializeParamsObj(HELLO_CONTRACT, {
  name: "World",
});
// Or simply `new TextEncoder().encode("World")`

await scaffold.fetch({
  contract: HELLO_CONTRACT,
  params,
  onResult: async (result) => {
    console.log(await result!.parse());
  },
});
```

## How?

- Contracts and generators are written in WebAssembly and placed onto the network. A contract verifies the work of a generator.
- Executors (browsers & servers) compete to resolve requests first, and are rewarded for their effort.
- Verifiers monitor the network and play a game with the executors; both try to pass incorrect solutions by the other, and are rewarded when they succeed.

## Design goals

- It's very fast. Low latency is the #1 design goal. There is very little overhead between the computation of a result and its optimistic availability to be used in another calculation.
- It's secure. Peers are incentivized to verify others’ results. Each result is signed with collateral, and consensus will progressively solidify trust in its validity. Incorrect results are flagged, voted on, penalized, and eventually eliminated from the graph.
- It's eventually immutable. Eventually, executions are baked into the global block graph, establishing consensus. We don't want this to happen too fast, because we want to give verifiers time to find, flag, and fix incorrect blocks. See non-goals below.

## Non-goals

- Fast finality. This would come at the expense of repairability.

## Features

- Write once, run everywhere. Scaffold embraces WebAssembly as the future of computing.
- Global load balancing. Because functions are executed on the global Scaffold network instead of a limited cluster of servers, it easily scales up or down with load.
- Pure, functional, lazy everything. Modules can do only one thing - output a result. No side-effects or mutation means reasoning about your code is easy and values are visible at every step.
- Multilingual. Contracts can be written in Rust, C++, AssemblyScript, Ruby, or any language that compiles to WASM.
