# Plan: Signature Contract

## Goal
Register a real signature contract function and make `requireSignature` verify the block's actual cryptographic signer rather than being a no-op.

## What Exists
- `SIGNATURE_CONTRACT` hash and `makeSignatureOutput(pubkey, value)` in Block.ts
- `requireSignature(pubkey)` on ContractEnv interface
- VerifyingEnv.requireSignature — stub that checks `params == pubkey` (tautological)
- GeneratingEnv.requireSignature — same stub
- `recoverPacketSigner(packet)` in Packet.ts — recovers compressed pubkey from signature
- `composeBlockPacket(blueprint, privateKey)` — signs blocks, but the signer isn't stored on the Block

## What Needs to Be Done

1. **Add `signer?: Uint8Array` to Block interface** — optional 33-byte compressed pubkey. Only set for blocks created from signed packets.

2. **Populate signer in `composeBlockPacket`** — derive pubkey from privateKey using `secp.getPublicKey(privateKey, true)` and set it on the block.

3. **Update VerifyingEnv** — accept `signer?: Uint8Array` in constructor opts. `requireSignature(pubkey)` checks `signer == pubkey`, throws ContractRejection if not.

4. **Update ExecutionModule** — pass block signer through to VerifyingEnv when creating it.

5. **Register the signature contract function**:
   ```typescript
   const signatureContract: ContractFn = (env) => {
     env.requireSignature(env.getParams());
   };
   ```

6. **Tests** — verify signed blocks pass, unsigned blocks fail, wrong-key blocks fail.

## Open Questions
None — the approach is fully defined by existing interfaces.
