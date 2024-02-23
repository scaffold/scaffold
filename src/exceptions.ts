import { DetailVote } from './CollateralUtil.ts';
import { Fact } from './FactMeta.ts';

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

export class BarrierException extends Error {
  constructor(msg: string) {
    super(msg);
  }
}
