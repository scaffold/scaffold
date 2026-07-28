There's 2 interfaces that scaffold defines:

1. The browser-facing TS interface
2. The contract-facing WASM interface

These do not include the configuration surface or the wire format.

Both interfaces are recognizably similar; both defining methods like `fetch`, `put`, and `send`. The difference is where they're called from. Additionally, the contract interface is called under two "environments", block generation and block verification. The API for each is the same, and under many circumstances the contract is unaware and uninterested in whether it's generating or verifying a block. For example, during block generation, the `send` method will add an output to the soon-to-be-published block. During block verification, the `send` method will verify that the given output exists on the block.
