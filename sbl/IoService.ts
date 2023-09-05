import { BlockInput } from '~/sbl/messages.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';

export default class IoService {
  private claimsByOutput = new Map<
    HashPrimitive,
    { block: BlockFact; inputIdx: number }[]
  >();

  public getClaims({ block_hash, output_idx }: BlockInput) {
    // TODO: I think this is secure (resistant to collisions), but should verify
    return getOrCreate(
      this.claimsByOutput,
      Hash.composePrimitives(
        block_hash.toPrimitive(),
        Hash.fromLiteral32(output_idx).toPrimitive(),
      ),
      () => [],
    );
  }
}
