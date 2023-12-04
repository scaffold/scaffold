import BlockBuilder from './BlockBuilder.ts';
import { collateralHash } from './constants.ts';
import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import KeyService from './KeyService.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
} from '~/sbl/collateralMessages.ts';
import FactService from '~/sbl/FactService.ts';
import CollateralUtil, { DetailVote, Posting } from '~/sbl/CollateralUtil.ts';

export default class LitigationService {
  constructor(private ctx: Context) {}

  public litigate(block: BlockFact, hints: Uint8Array[], vote: DetailVote) {
    vote = this.ctx.get(FactService).updateValidity(block.hash, hints, vote);
    this.rectify(block, [{
      detail: {
        public_key: this.ctx.get(KeyService).getSelfPublicKey(),
        hints,
        vote,
      },
      amount: 0n,
    }]);
  }

  public rectify(block: BlockFact, extraPostings?: Posting[]) {
    CollateralUtil.applyAllBeliefs(
      CollateralUtil.buildTree(
        extraPostings
          ? [...block.collateralizations, ...extraPostings]
          : block.collateralizations,
      ),
      (hints) => this.ctx.get(FactService).getValidity(block.hash, hints),
      (hints, vote, amount) =>
        this.ctx.get(BlockBuilder).publish({
          outputs: [{
            verifier: {
              contract_hash: collateralHash,
              params: CollateralContractParams.encode({
                block_hash: block.hash,
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
