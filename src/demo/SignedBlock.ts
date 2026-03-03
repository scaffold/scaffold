import { secp } from '../util/secp.ts';
import { Block } from '../Block.ts';

export interface SignedBlock {
  block: Block;
  signature: Uint8Array; // 64-byte compact signature
}

/** Sign a block's hash with a private key. */
export function signBlock(block: Block, privateKey: Uint8Array): SignedBlock {
  const sig = secp.sign(block.hash.toBytes(), privateKey);
  return { block, signature: sig.toCompactRawBytes() };
}

/** Verify a block's signature against an expected public key. */
export function verifyBlockSignature(sb: SignedBlock, expectedPublicKey: Uint8Array): boolean {
  try {
    return secp.verify(sb.signature, sb.block.hash.toBytes(), expectedPublicKey);
  } catch {
    return false;
  }
}

/** Attempt to recover the signer's compressed public key from the signature. */
export function recoverSignerPublicKey(sb: SignedBlock): Uint8Array | undefined {
  const msg = sb.block.hash.toBytes();
  const sig = secp.Signature.fromCompact(sb.signature);

  for (const bit of [0, 1] as const) {
    try {
      const recovered = sig.addRecoveryBit(bit).recoverPublicKey(msg);
      return recovered.toRawBytes(true); // compressed 33 bytes
    } catch {
      // try next recovery bit
    }
  }
  return undefined;
}
