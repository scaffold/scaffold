import Hash from './util/Hash.ts';
import HashRegistry from './util/HashRegistry.ts';
import { Block, Claim, Incentive } from './messages.ts';

// Hash<Block> -> Block
export class BlockRegistry extends HashRegistry<Block> {}

// Hash<Verifier> -> Things I can claim if I publish an answer
export class IncentiveRegistry extends HashRegistry<Claim[]> {}

// Hash<Verifier> -> Blocks that claim to fulfill this verifier; whether valid or not
export class FulfillmentRegistry extends HashRegistry<Block[]> {}
