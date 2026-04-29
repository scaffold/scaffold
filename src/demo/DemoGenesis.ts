import { Block, composeGenesisPacket } from '../core/Block.ts';
import { ANIMALS, deriveIdentity } from './Identity.ts';
import { makeStatusOutput } from './StatusContract.ts';

/**
 * Create the deterministic shared genesis block.
 * All nodes compute the identical genesis independently because:
 * - Fixed animal order (ANIMALS array)
 * - Deterministic key derivation (Hash.digest of name)
 * - Deterministic hashing via packet serialization
 */
export function createDemoGenesis(): Block {
  const outputs = ANIMALS.map((name) => {
    const identity = deriveIdentity(name);
    return makeStatusOutput(identity.publicKey, '');
  });
  return composeGenesisPacket(outputs);
}
