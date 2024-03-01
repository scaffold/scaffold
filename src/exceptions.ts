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

// TODO: Use better ingestion flow so we don't need this
// export class DiscardFactException extends Error {
//   constructor(public fact: Fact) {
//     super(`Signifies that this fact shouldn't be saved`);
//   }
// }
