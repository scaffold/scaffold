import { BlockExt } from './BlockMeta.ts';
import Context from './Context.ts';
import { LocalGeneratorOpts } from './LocalGeneratorService.ts';
import { EpochBody, EpochParams } from './messages.ts';
import Hash, { HASH_SIZE } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { MaybePromise } from './util/types.ts';

// const epochIv = Hash.fromHex(
//   'd2e66375ccb9e7c2ccdf5ef538a78f010d34aa3b4c7802837da358e833441c7e',
// );
const epochIv = Hash.fromLiteral32(0);

const epochBaseTime = BigInt((() => {
  // This is temporary, for easy development.
  // Eventually the base time will be fixed.
  const hour = 1000 * 60 * 60;
  return Math.floor(Date.now() / hour) * hour;
})());
// const epochBaseTime = BigInt(new Date('2022-04-22T18:40:00-0700').getTime());
const epochIntervalMs = 1000n;
const timeToHeight = (time: number) => {
  if (time > epochBaseTime) {
    return (BigInt(time) - epochBaseTime) / epochIntervalMs;
  } else {
    return 0n;
  }
};

// Also verify that the block isn't too big.

// Only used in tests,
// Used to make sure that generating epoch contracts "out-of-spec" never wins.
export const enum EpochGeneratorModifier {
  None,
}

export default class EpochContract {
  // private inclusionHashes = new Map<
  //   number,
  //   { block: BlockExt; outputIdx: number; hash: Hash }[]
  // >();
  private inclusionHashes: {
    block: BlockExt;
    outputIdx: number;
    hash: Hash;
  }[] = [];

  constructor(private ctx: Context) {
    // ctx.get(LocalGeneratorService).addGenerator(
    //   dataHash,
    //   EpochContract.generate,
    // );
  }

  public addInclusionHash(block: BlockExt, outputIdx: number, hash: Hash) {
    this.inclusionHashes.push({ block, outputIdx, hash });
  }
  private getInclusionHashes() {
    this.inclusionHashes = this.inclusionHashes.filter(({ block, outputIdx }) =>
      block.outputClaims[outputIdx].length === 0
    );
    return this.inclusionHashes;
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
  }

  public async generate(
    { ctx, contractHash, params, emitCorrect, request, fulfills }:
      LocalGeneratorOpts,
    modifier = EpochGeneratorModifier.None,
  ) {
    const { height } = EpochParams.decode(params);

    let priorHash = height
      ? Hash.digest(
        await request(
          contractHash,
          EpochParams.encode({ height: height - 1n }),
        ),
      )
      : epochIv;

    const skipHash = height
      ? Hash.digest(
        await request(
          contractHash,
          EpochParams.encode({ height: height - (height & -height) }),
        ),
      )
      : epochIv;

    if (!emitCorrect) {
      priorHash = priorHash.increment();
    }

    // Wait for time
    // request(
    //   timeContractHash,
    //   timeMessages.Params.encode({
    //     time: epochBaseTime + height * epochIntervalMs,
    //   }),
    // );

    const events = this.getInclusionHashes().map(
      ({ block, outputIdx, hash }) => {
        fulfills(block, outputIdx);
        return hash;
      },
    );

    return EpochBody.encode({
      prior_hash: priorHash,
      skip_hash: skipHash,
      events,
    });

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
