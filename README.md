# Scaffold.io
_Cool tagline_

## What is it?
Scaffold moves the cloud to the client. Scaffold connects browsers to each other via WebRTC, replacing GCP/AWS (saving $$$). Its #1 design goal is speed. Scaffold is fully trustless and verified; in fact invalid blocks are incentivized and quickly replaced.
Scaffold is fetch() over P2P. It moves the cloud to the client. Servers (running in users browsers) are fully dynamic and persist state. Its #1 design goal is speed. Scaffold connects browsers to each other via WebRTC, and is fully decentralized, trustless, and verified.

## What is it not?
Scaffold is not a blockchain. It is not designed for fast consensus; in fact the opposite is desirable in many cases - in order to use blocks optimistically, before we've been able to verify them, we need to be able to easily re-write the graph if they're incorrect.
Scaffold is not a cryptocurrency. While it does use coins, due to the slow consensus, they aren't useful for large transactions. The small transactions used for incentivizing computation are the perfect use case.

## Usage
```ts
ctx.get(FetchService).fetch(
  {
    contractHash: MyContract.hash,
    params: MyContract.encodeParams({x: 5, y: 7}),
  },
  (block) => console.log(MyContract.decodeBody(block.body)), // 12
);
// TODO: Example that shows speed
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
- Fast immutability. This would come at the expense of repairability.

## Features
- Write once, run everywhere. Scaffold embraces WebAssembly as the future of computing.
- Global load balancing. Because functions are executed on the global Scaffold network instead of a limited cluster of servers, it easily scales up or down with load.
- Pure, functional, lazy everything. Modules can do only one thing - output a result. No side-effects or mutation means reasoning about your code is easy and values are visible at every step.
- Multilingual. Contracts can be written in Rust, C++, AssemblyScript, Ruby, or any language that compiles to WASM.

## Use cases
- Dynamic web hosting
- Content distribution
- Multiplayer gaming
- Image/video processing

## Getting started
```ts
const config: Config = {
  ...defaultConfig,

  selfPrivateKey: secp.utils.randomPrivateKey(),

  networkProvider: {
    protocols: new Map(Object.entries({
      websocket: new WebsocketClientProvider(),
      webrtc: new WebrtcProvider(),
    })),
  },
};

const ctx = new Context(config);
ctx.get(ConnectionService).connect('websocket', 'ws://127.0.0.1:8314');

const codeBlock = ctx.get(PutService).put(str2bin(`
  import { params } from 'scaffold/module';
  const name = new TextDecoder().decode(params);
  return 'Hello ' + name + '!';
`));

const interpBlock = await ctx.get(FetchService).fetch({
  contractHash: quickJsHash,
  params: codeBlock.hash.toBytes(),
});

const responseBlock = await ctx.get(FetchService).fetch({
  contractHash: interpBlock.hash,
  params: new TextDecoder().encode('world'),
});

console.log(responseBlock.body);

ctx.destruct();
```

## Development
```sh
# Clone
git clone git@github.com:SublimeNet/sublime.git
cd sublime

# Run formatter
deno task fmt

# Run linter
deno task lint

# Run tests
deno task test

# Run websocket server (required for initial P2P connection)
deno task serve-ws

# Bundle js
deno task serve-ui

# Open in browser
open http://localhost:1234/
```
