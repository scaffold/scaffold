import { BlockBuilder } from './BlockBuilder.ts';
import { collateralHash } from './hashes.ts';
import { Context } from './Context.ts';
import { Fact } from './FactMeta.ts';
import { KeyService } from './KeyService.ts';
import { FactService } from './FactService.ts';
import { CollateralUtil, DetailVote, Posting } from './CollateralUtil.ts';
import { encodeDataTree } from './DataTreeHelper.ts';
import { DataTree } from './protocol/base.ts';

export class LitigationService {
  constructor(private ctx: Context) {}

  public litigate(fact: Fact, hints: DataTree[], vote: DetailVote) {
    vote = this.ctx.get(FactService).updateValidity(fact.hash, hints, vote);
    this.rectify(fact, [{
      detail: {
        publicKey: this.ctx.get(KeyService).getSelfPublicKey(),
        hints,
        vote,
      },
      amount: 0n,
    }]);
  }

  public rectify(fact: Fact, extraPostings?: Posting[]) {
    CollateralUtil.applyAllBeliefs(
      CollateralUtil.buildTree(
        extraPostings ? [...fact.collateralizations, ...extraPostings] : fact.collateralizations,
      ),
      (hints) => this.ctx.get(FactService).getValidity(fact.hash, hints),
      (hints, vote, amount) =>
        this.ctx.get(BlockBuilder).publishPersistentDraft({
          outputs: [{
            verifier: {
              contractHash: collateralHash,
              params: encodeDataTree({ blockHash: fact.hash }),
            },
            amount,
            detail: encodeDataTree({
              publicKey: this.ctx.get(KeyService).getSelfPublicKey(),
              hints,
              vote,
            }),
          }],
          timeout: 0,
        }),
    );
  }
}
