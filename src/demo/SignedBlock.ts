import { secp } from '../util/secp.ts';
import { Block } from '../core/Block.ts';

export interface SignedBlock {
  block: Block;
  signature: Uint8Array; // 65 bytes: 1-byte recovery bit + 64-byte compact signature
}

/** Sign a block's hash with a private key. */
export function signBlock(block: Block, privateKey: Uint8Array): SignedBlock {
  const sig = secp.sign(block.hash.toBytes(), privateKey);
  const compact = sig.toCompactRawBytes();
  const signature = new Uint8Array(65);
  signature[0] = sig.recovery;
  signature.set(compact, 1);
  return { block, signature };
}

/** Verify a block's signature against an expected public key. */
export function verifyBlockSignature(sb: SignedBlock, expectedPublicKey: Uint8Array): boolean {
  try {
    const compact = sb.signature.subarray(1);
    return secp.verify(compact, sb.block.hash.toBytes(), expectedPublicKey);
  } catch {
    return false;
  }
}

/** Attempt to recover the signer's compressed public key from the signature. */
export function recoverSignerPublicKey(sb: SignedBlock): Uint8Array | undefined {
  const msg = sb.block.hash.toBytes();
  const recoveryBit = sb.signature[0] as 0 | 1;
  const compact = sb.signature.subarray(1);
  const sig = secp.Signature.fromCompact(compact).addRecoveryBit(recoveryBit);

  try {
    const recovered = sig.recoverPublicKey(msg);
    return recovered.toRawBytes(true); // compressed 33 bytes
  } catch {
    return undefined;
  }
}
