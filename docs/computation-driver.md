# The computation driver

| Property or method     | Use in contracts | Use in generators |
| ---------------------- | ---------------- | ----------------- |
| type                   | Type.Contract    | Type.Generator    |
| getContractHash()      | ✅               | ✅                |
| getParams()            | ✅               | ✅                |
| getHint()              | ✅               | ❌                |
| getBody()              | ✅               | ❌                |
| requireBody()          | ✅               | ✅                |
| requireOutput()        | ✅               | ✅                |
| requireTimestampGte()  | ✅               | ✅                |
| requireSignature()     | ✅               | ✅                |
| emitCorrect()          | ❌               | ✅                |
| notify()               | no-op            | ✅                |
| request()              | ✅               | ✅                |
| fulfills()             | ✅               | ✅                |
| getInputCount()        | ✅               | ✅                |
| getInputSource()       | ✅               | ✅                |
| requireFrontierLevel() | ✅               | ✅                |
| compareBlockOrder()    | ✅               | ✅                |
| pass()                 | ✅               | ✅                |
| fail()                 | ✅               | ✅                |
| setResult()            | ✅               | ✅                |
| offsetCanonicality()   | ✅               | ✅                |
| ingenerable()          | ❌               | ✅                |

## type

Returns ComputationType.Contract for contract invocations, and
ComputationType.Generator for generator invocations.

## getContractHash(): Hash

Returns the hash of the WASM of the contract that is currently verifying, or for
generators, returns the hash that will eventually verify the block we create.

## getParams(): Uint8Array

Returns the parameters that this contract is being invoked with. This is
user-data and its usage will vary between contracts.

## getHint(idx: number, bop: BurdenOfProof): Uint8Array

See [Hints](hints.md)
