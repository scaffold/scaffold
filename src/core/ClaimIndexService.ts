import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { AtomType, ResolvingClaim } from './types.ts';

export class ClaimIndexService {
  constructor(private ctx: Context) {}

  propagateClaim(claim: ResolvingClaim): void {
    assert(!claim.resolved);
    if (claim.producer.type !== AtomType.Block) return;

    let outputIdx = claim.outputIdx;
    const outputCount = BigInt(claim.producer.payload.outputs.length);
    if (outputIdx < outputCount) {
      claim.resolved = true;
      return;
    }
    outputIdx -= outputCount;

    for (let i = claim.producer.aggregates.length; i-- > 0;) {
      const { block, outputCount } = claim.producer.aggregates[i];
      if (outputIdx < outputCount) {
        claim.producer = block;
        claim.outputIdx = outputIdx;
        this.propagateClaim(claim);
        return;
      }
      outputIdx -= outputCount;
    }

    if (claim.producer.anchor === undefined) throw new Error('Claim index out of bounds');

    claim.producer = claim.producer.anchor;
    claim.outputIdx = outputIdx;
    this.propagateClaim(claim);
  }
}
