import { Block, createGenesisBlock } from '../core/Block.ts';
import { ANIMALS, deriveIdentity } from './Identity.ts';
import { makeStatusOutput } from './StatusContract.ts';

/**
 * Create the deterministic shared genesis block.
 * All nodes compute the identical genesis independently because:
 * - Fixed animal order (ANIMALS array)
 * - Deterministic key derivation (Hash.digest of name)
 * - Deterministic hashing in createGenesisBlock
 */
export function createDemoGenesis(): Block {
  const outputs = ANIMALS.map((name) => {
    const identity = deriveIdentity(name);
    return makeStatusOutput(identity.publicKey, '');
  });
  return createGenesisBlock(outputs);
}
