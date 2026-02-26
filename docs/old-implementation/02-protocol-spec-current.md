# Current Protocol Specification (Code-Extracted)

This is the protocol as implemented in the current `scaffold/src` code, not the idealized version.

## 1. Packet format

Each fact packet is:

- 3-byte magic: `SCF`
- 1-byte fact type
- encoded payload (Avro schemas from `protocol/base.ts` and `messages.ts`)
- optional signature tail (`64-byte compact sig + 1-byte recovery`)

Hash identity is `Hash.digest(full_packet_bytes)`.

## 2. Fact kinds

- `Block`: core protocol state transition.
- `PeerInfo`: signed peer capability/metadata.
- `ConnectionSignal`: encrypted signaling envelope for connection setup.
- `Index`: transient hash notification/request/latency feedback.

## 3. Block object (normative shape)

Block fields (key protocol fields):

- `parent: hash`
- `squashes: Squash[]` where `Squash = { blockHash, newUtxoCount }`
- `volume: int`
- `squashedUtxoIdxs: int[]`
- `treeWeights: bigint[]`
- `refs: hash[]`
- `inputs: BlockInput[]`
- `outputs: BlockOutput[]`
- `body: DataTree`
- `claimWeightBoost: long`
- `timestamp: long`

`BlockInput`:

- `blockHash, outputIdx`
- `utxoIdx` (index in this block’s effective UTXO space)
- `groupIdx` (verifier group partition)

`BlockOutput`:

- `verifier = { contractHash, params }`
- `amount` (signed bigint)
- `detail` (DataTree)
- `groupIdx`

## 4. Invariants currently enforced

At ingest time, the code enforces:

- unique squash block hashes,
- `treeWeights.length <= 256`,
- each tree weight is non-negative,
- non-genesis block must have at least one external input (`utxoIdx >= outputs.length` on some
  input),
- each input has `outputIdx >= 0`, `utxoIdx >= 0`, `groupIdx >= 0`,
- each output has `groupIdx >= 0`,
- negative output amounts only allowed for `frontierHash`,
- optional feature gates:
  - if `enableFrontierVote=false`, only zero parent allowed,
  - if `enableBlockThroughput=false`, non-genesis outputs must all be zero.

## 5. Invariants present in design but not fully enforced

The codebase contains checks/logic that are defined but not currently applied end-to-end:

- squashability/volume ratio checks exist but are not called in main ingest path,
- strict zero-sum IO check exists but is not the primary ingest gate,
- advanced verifier driver APIs are still stubs for some contract behaviors,
- frontier contract compute path is effectively a no-op in current provider.

## 6. Aggregation semantics

The canonical link model is:

- choose a `parent` block (or zero),
- include merge heads as `squashes`,
- rebase all spent indices into parent output space,
- carry subtree weight summary through `treeWeights`.

This model is built by:

- `FrontierService3.create` (head/parent choice),
- `FrontierService.build` (rebasing and header field synthesis).

## 7. Verification group model

`groupIdx` couples related inputs/outputs so verifier execution can be scoped to the right contract
group.

During ingest, linking an input to a parent output triggers verifier launch with a hint prefix
identifying the verifier group.

## 8. Collateral/validity model

Validity is keyed by `(blockHash, hint-path-hash)` and stores vote outcomes. Votes are constrained
to not switch contest type after first assignment, and not flip resolved leaf results.

Collateral postings are separate outputs with `collateralHash` verifier and detail containing:

- poster pubkey,
- hint path,
- vote enum.

`CollateralUtil` computes outcome/payout from the posting tree.
