import HashRegistry from './util/HashRegistry.ts';
import { Block, BlockInput, Verifier } from './messages.ts';

// Hash<Block> -> Block
export class BlockRegistry extends HashRegistry<Block> {}

// Hash<Verifier> -> Things I want to incentivize that I haven't sent yet
export class PendingIncentiveRegistry extends HashRegistry<
  { verifier: Verifier; amount: bigint; forceAfter: number }
> {}

// Hash<Verifier> -> Things I can claim if I publish an answer
export class IncentiveRegistry
  extends HashRegistry<{ verifier: Verifier; inputs: BlockInput[] }> {}

// Hash<Verifier> -> Blocks that claim to fulfill this verifier; whether valid or not
export class FulfillmentRegistry extends HashRegistry<Block[]> {}

// Hash<Verifier> -> Blocks that claim to provide a generator for this verifier
export class GeneratorRegistry extends HashRegistry<Block[]> {}
