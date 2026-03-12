First, read AGENTS.md and docs/protocol/*.md to understand the current protocol.

One concept I think we should do is a verification/deception game, where clients are incentivized for occasionally publishing invalid blocks. If they successfully publish an invalid block, after some time, they can "catch" it themselves and win a much bigger jackpot than if someone else caught it. For example: +1 for a correct answer, -1000 when a peer catches one of your incorrect answers, and +1,000,000 when no one catches your incorrect answer. There's a nice nash equilibrium here; if they attempt deception too much, verification will become more profitable and balance it out. Too little and the verifiers will "starve" and they will spend less energy verifying, which will make deception more likely to succeed. There's a couple of goals for this game:
1. Incentivize verification
2. Incentivize clients to flag invalid blocks they do publish, so dependencies can be corrected
3. Prevent MITM re-attribution. Let's say a client between the requester and the responder receives a block containing the result of a computation. If it knows it is correct, it can simply re-publish the result and claim the incentive for himself. However, because it doesn't know the validity of the result, claiming it may cause its own answer to be caught, without the upside of being able to claim jackpots if no one catches it.

We're at a point where we need to start nailing down computation and verification. I want to brainstorm various ideas and concepts and hopefully decide on a direction. Things that ideally should fit into the model we choose:

- Looking up a block (or just data in general) by hash. This is likely to be accomplished by publishing a block incentivizing (outputting) to a contract that fulfills when the claiming block contains data matching the hash. Some considerations: MITM peers are easily able to verify whether the data is correct, so the verification game is less likely to be effective in this case.

- A two-stage process for looking up data by hash: First, publish a commitment to `HASH(data || secret)`, along with the secret. Then, wait for a peer to pay you (this could be via a challenge to your commitment), and publish the data in response. See the "secret/offline state" concept below; this fits into that idea.

- A typical computation where verification pretty much equals the original computation. For example, simulating the next "frame" or tick of a game world. The type of this computation is pretty much `GameState -> GameState`, so there's no need for a fancy interface on top of it. Just read a byte array (the previous tick) and return a byte array.

- Structured data as input and output. An example here might be compiling a program that consumes a disk image or filesystem state and outputs the same. Technically, you could compact the input and output using something like tar, but it would be interesting to be able to have an interface on top of that allowing reading individual files. I really want Scaffold to be a nice development experience, so even for apps that don't need it, it would be really nice to allow for explorers or deserializers to be declared on a block, allowing a generic block explorer visibility into inputs and outputs. This may or may not be implemented as the secret/offline state concept below, depending on whether the block stores the full filesystem state or just a hash of it.

- Secret/offline state. An example here is a merkle tree (like the claim mask merkle tree in an aggregation block). The block would store only the merkle root, and subtree queries would go to the publishing client, who would be incentivized to return a response as quickly as possible because while a query (or challenge) is pending, the block is considered invalid and other peers won't want to build upon it.

Some ideas to unify these things:
1. Be as flexible as possible, and just require each block to have a WASM hash that implements a minimal interface, maybe something like (1) a strong verifier that runs a contract and either requests more data (like the secret state) or resolves concretely to PASS or FAIL, (2) a weak verifier that looks for collateral voting FOR or AGAINST the block, and (3) a solidifier that, given the result of the strong verifier, generates a weak verifier collateral block. This seems tricky to pull off, mostly because each block is defining its own verification so it's hard to trust it.
2. Each block encodes the commitment, and allows queries based on voting. This is the approach I was heading down before - see legacy2/collateralMessages.ts legacy2/CollateralUtil.ts, legacy2/tests/collateral.test.ts, and legacy2/tests/contracts/CollateralContract.test.ts
3. Every block allows queries that either (1) run on the requestor's machine, if it's just a simple deserialization query, or (2) generate an incentive and runs on the publisher's machine, if the secret/offline state is involved. For example, the WASM runs and if it calls to the host with a "request data by hash" or "request secret state", we know we need to incentivize the publisher to respond. The response could be either a block or a collateral posting against the original block, depending on whether we want validity to be voted upon separately or as an atomic unit.
4. Something else?

I'm not sure whether we should try to unify challenges/contestations, and queries.
- A challenge response is vital for the validity of the original block. It should be attached and unable to be modified.
- A query, like a deserializer, is a lot more flexible. We want those to be able to be modified, for example to add or extend the behavior of some byte array of state.

These are just my thoughts. I want you to brainstorm and think about the primitives we could define to build and support these things.

You are part of a ralph loop and likely building on previous explorations. They are documented in brainstorming/compute/explorations/*.md, and the results are documented in brainstorming/compute/summary.md. I want you to do 3 things:
1. Read brainstorming/compute/summary.md to understand what's already been explored.
2. Choose a direction to explore. Feel free to read the details of prior explorations if you're interested, but try to choose a direction that hasn't been explored yet.
3. Do a deep-dive into what the protocol would look like. What additional properties would you need to add to the block schema, what would the block interface look like, and what would be the development experience of building and understanding various systems, including what I've outlined above?
4. Document your deep-dive in a new brainstorming/compute/explorations/X.md file and write a summary in brainstorming/compute/summary.md. The summary should include (1) the direction you explored, (2) the main implications you discovered, and (3) an objective comparison with some of the other explorations.