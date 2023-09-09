import BlockService from './BlockService.ts';
import { collateralHash, dataHash } from './constants.ts';
import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import LocalGeneratorService, {
  INGENERABLE_FLAG,
  LocalGeneratorOpts,
} from './LocalGeneratorService.ts';
import { Block, CollateralContractParams } from './messages.ts';
import NodeService from './NodeService.ts';
import { arrEquals } from './util/buffer.ts';
import Hash, { HASH_SIZE } from './util/Hash.ts';
import secp from './util/secp.ts';
import { MaybePromise } from './util/types.ts';
import FactService from '~/sbl/FactService.ts';

// Only used in tests,
// Used to make sure that generating collateral contracts "out-of-spec" never wins.
export const enum CollateralGeneratorModifier {
  None,
  OmitFor,
  OmitAgainst,
}

export const COLLATERAL_INPUT_IDX_INITIAL = -1;
export const COLLATERAL_INPUT_IDX_ISOLATED = -2;

export default class CollateralContract {
  constructor(private ctx: Context) {
    // ctx.get(LocalGeneratorService).addGenerator(
    //   dataHash,
    //   CollateralContract.generate,
    // );
  }

  public async verify(
    params: Uint8Array,
    block: BlockFact,
    // request: (
    //   contractHash: Hash,
    //   params: Uint8Array,
    // ) => MaybePromise<Uint8Array>,
    invert: (hash: Hash) => MaybePromise<Uint8Array>,
  ) {
    throw new Error(`TODO: Implement`);

    // const { block_hash, valid, public_key, free_after } =
    //   CollateralContractParams.decode(params);

    // if (block.timestamp < free_after) {
    //   // Contestion
    //   // Flip for/against; extend free_after timestamps
    //   // TODO: Check that the collateral inputs are (1) all from the same block and (2) exactly the collateral outputs of that block.
    //   const outputs = await Promise.all(
    //     block.inputs.map(async ({ block_hash, output_idx }) =>
    //       Block.decode(await invert(block_hash)).outputs[output_idx]
    //     ),
    //   );
    //   const collaterals = outputs.filter(({ verifier }) =>
    //     Hash.equals(verifier.contract_hash, collateralHash)
    //   );
    //   return collaterals.every((find) =>
    //     block.outputs.some((candidate) =>
    //       candidate.amount === find.amount &&
    //       Hash.equals(
    //         candidate.verifier.contract_hash,
    //         find.verifier.contract_hash,
    //       ) && arrEquals(candidate.verifier.params, find.verifier.params)
    //     )
    //   );
    // } else {
    //   // Free collateral
    //   return this.ctx.get(FactService).verify(block, public_key);
    // }
  }

  public static generate(
    { ctx, params, inputIdx, emitCorrect, addOutput, invert, request }:
      LocalGeneratorOpts,
    modifier = CollateralGeneratorModifier.None,
  ) {
    //     const {collateral_input_idx,valid,
    //       public_key,
    //       free_after,
    //     } = CollateralContractParams.decode(params);

    // const availableCollateral=10n;

    // const inputCollateral=invert()
    //     addOutput({amount:})

    //     const block = ctx.get(BlockService).get(hash);
    //     if (block) {
    //       if (emitCorrect) {
    //         const data = Block.encode(block);
    //         const commitment = Hash.digestParts(
    //           data,
    //           secret,
    //           ctx.get(NodeService).getSelfHash(),
    //         );
    //         return commitment.toBytes();
    //       } else {
    //         return Hash.random().toBytes();
    //       }
    //     } else {
    //       return INGENERABLE_FLAG;
    //     }
  }
}
