import { DetailVote } from '~/sbl/CollateralUtil.ts';
import { Fact } from '~/sbl/FactMeta.ts';

export class LitigableException extends Error {
  constructor(
    msg: string,
    public litigation: { fact: Fact; hints: Uint8Array[]; vote: DetailVote },
  ) {
    super(msg);
  }
}

export class ParsingException extends Error {
  constructor(msg: string, public fact: Fact) {
    super(msg);
  }
}
