import Hash from './util/Hash.ts';
import HashRegistry from './util/HashRegistry.ts';
import { Block, Claim, Incentive } from './messages.ts';

export class BlockRegistry extends HashRegistry<Block> {}

export class IncentiveRegistry extends HashRegistry<Claim[]> {}
