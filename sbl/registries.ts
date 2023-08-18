import HashRegistry from './util/HashRegistry.ts';
import { BlockInput, Verifier } from './messages.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';

// Hash<BlockFact> -> BlockFact
export class BlockRegistry extends HashRegistry<BlockFact> {}

// Hash<Verifier> -> Things I want to incentivize that I haven't sent yet
export class PendingIncentiveRegistry extends HashRegistry<
  { verifier: Verifier; amount: bigint; forceAfter: number }
> {}

// Hash<Verifier> -> Things I can claim if I publish an answer
export class IncentiveRegistry
  extends HashRegistry<{ verifier: Verifier; inputs: BlockInput[] }> {}

// Hash<Verifier> -> Blocks that claim to fulfill this verifier; whether valid or not
export class FulfillmentRegistry extends HashRegistry<BlockFact[]> {}

// Hash<Verifier> -> Blocks that claim to provide a generator for this verifier
export class GeneratorRegistry extends HashRegistry<BlockFact[]> {}
