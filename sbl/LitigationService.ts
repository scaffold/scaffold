import BlockBuilder from './BlockBuilder.ts';
import { collateralHash } from './constants.ts';
import Context from './Context.ts';
import { Fact } from '~/sbl/FactMeta.ts';
import KeyService from './KeyService.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
} from '~/sbl/collateralMessages.ts';
import FactService from '~/sbl/FactService.ts';
import CollateralUtil, { DetailVote, Posting } from '~/sbl/CollateralUtil.ts';

export default class LitigationService {
  constructor(private ctx: Context) {}

  public litigate(fact: Fact, hints: Uint8Array[], vote: DetailVote) {
    vote = this.ctx.get(FactService).updateValidity(fact.hash, hints, vote);
    this.rectify(fact, [{
      detail: {
        public_key: this.ctx.get(KeyService).getSelfPublicKey(),
        hints,
        vote,
      },
      amount: 0n,
    }]);
  }

  public rectify(fact: Fact, extraPostings?: Posting[]) {
    CollateralUtil.applyAllBeliefs(
      CollateralUtil.buildTree(
        extraPostings
          ? [...fact.collateralizations, ...extraPostings]
          : fact.collateralizations,
      ),
      (hints) => this.ctx.get(FactService).getValidity(fact.hash, hints),
      (hints, vote, amount) =>
        this.ctx.get(BlockBuilder).publish({
          outputs: [{
            verifier: {
              contract_hash: collateralHash,
              params: CollateralContractParams.encode({
                block_hash: fact.hash,
              }),
            },
            amount,
            detail: CollateralContractDetail.encode({
              public_key: this.ctx.get(KeyService).getSelfPublicKey(),
              hints,
              vote,
            }),
          }],
        }, 0),
    );
  }
}
