import { BlockFact, BlockSetFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';

interface EmptyFrontier {
  type: undefined;
  hash: Hash;
  level: number;
  votes: bigint;
}

export default class FrontierService2 {
  private blocks: BlockFact[] = [];

  // This is the canonical (to our best knowledge) frontier.
  // Unmerged blocks or left?/right? merged blocks that ...
  private frontierSets: BlockSetFact[] = [];
  private frontierBlock?: BlockFact;

  private emptyFrontiers: EmptyFrontier[] = [];
  // private bestEmptyFrontier: EmptyFrontier;
  private emptyIdx = 0;

  private outputs = new Map<HashPrimitive, number>();

  // private updateEnqueued = false;

  constructor(private ctx: Context) {}
}
