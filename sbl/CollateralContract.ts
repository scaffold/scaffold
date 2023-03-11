import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { collateralHash, dataHash } from './constants.ts';
import Context from './Context.ts';
import LocalGeneratorService, {
  INGENERABLE_FLAG,
  LocalGeneratorOpts,
} from './LocalGeneratorService.ts';
import { Block, CollateralContractParams } from './messages.ts';
import NodeService from './NodeService.ts';
import { arrEquals } from './util/buffer.ts';
import Hash, { HASH_SIZE } from './util/Hash.ts';
import { MaybePromise } from './util/types.ts';

// Only used in tests,
// Used to make sure that generating collateral contracts "out-of-spec" never wins.
export const enum CollateralGeneratorModifier {
  None,
  OmitFor,
  OmitAgainst,
}

export default class CollateralContract {
  constructor(private ctx: Context) {
    // ctx.get(LocalGeneratorService).addGenerator(
    //   dataHash,
    //   CollateralContract.generate,
    // );
  }

  public async verify(
    params: Uint8Array,
    block: BlockExt,
    // request: (
    //   contractHash: Hash,
    //   params: Uint8Array,
    // ) => MaybePromise<Uint8Array>,
    invert: (hash: Hash) => MaybePromise<Uint8Array>,
  ) {
    const {
      public_key_hash,
      free_after,
      data_price,
    } = CollateralContractParams.decode(params);

    if (block.timestamp < free_after) {
      // Contestion
      // Flip for/against; extend free_after timestamps
      const outputs = await Promise.all(
        block.inputs.map(async ({ block_hash, output_idx }) =>
          Block.decode(await invert(block_hash)).outputs[output_idx]
        ),
      );
      const collaterals = outputs.filter(({ verifier }) =>
        Hash.equals(verifier.contract_hash, collateralHash)
      );
      return collaterals.every((find) =>
        block.outputs.some((candidate) =>
          candidate.amount === find.amount &&
          Hash.equals(
            candidate.verifier.contract_hash,
            find.verifier.contract_hash,
          ) && arrEquals(candidate.verifier.params, find.verifier.params)
        )
      );
    } else {
      // Free collateral
      return Hash.equals(block.signer, public_key_hash);
    }
  }

  // public static generate(
  //   { ctx, params, emitCorrect, request }: LocalGeneratorOpts,
  //   modifier = CollateralGeneratorModifier.None,
  // ) {
  //   const { hash, secret } = CollateralContractParams.decode(params);
  //   const block = ctx.get(BlockService).get(hash);
  //   if (block) {
  //     if (emitCorrect) {
  //       const data = Block.encode(block);
  //       const commitment = Hash.digestParts(
  //         data,
  //         secret,
  //         ctx.get(NodeService).getSelfHash(),
  //       );
  //       return commitment.toBytes();
  //     } else {
  //       return Hash.random().toBytes();
  //     }
  //   } else {
  //     return INGENERABLE_FLAG;
  //   }
  // }
}
