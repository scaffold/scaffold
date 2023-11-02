import Context from './Context.ts';
import LocalGeneratorService from './LocalGeneratorService.ts';
import { epochHash, timeHash } from '~/sbl/constants.ts';
import { EpochBody, EpochParams, TimeParams } from './messages.ts';
import Hash, { HASH_SIZE, ZERO_HASH } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { MaybePromise } from './util/types.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';

// const epochIv = Hash.fromHex(
//   'd2e66375ccb9e7c2ccdf5ef538a78f010d34aa3b4c7802837da358e833441c7e',
// );
const epochIv = ZERO_HASH;

let epochBaseTime = 0n;
// let epochBaseTime = BigInt((() => {
//   // This is temporary, for easy development.
//   // Eventually the base time will be fixed.
//   const hour = 1000 * 60 * 60;
//   return Math.floor(Date.now() / hour) * hour;
// })());
// let epochBaseTime = BigInt(new Date('2050-01-01T00:00:00-0000').getTime());
export const debugSetEpochBaseTime = (baseTime: number) => {
  console.log(
    `Setting the epoch base time to ${baseTime}, which was ${
      Date.now() - baseTime
    } ms ago`,
  );
  epochBaseTime = BigInt(baseTime);
};

const epochIntervalMs = 1000n;
const timeToHeight = (time: number) => {
  if (epochBaseTime === 0n) {
    throw new Error(`Epoch base time hasn't been set yet!`);
  }

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
  //   { block: BlockFact; outputIdx: number; hash: Hash }[]
  // >();
  private inclusionHashes: {
    block: BlockFact;
    outputIdx: number;
    hash: Hash;
  }[] = [];

  constructor(private ctx: Context) {
    ctx.get(LocalGeneratorService).addGenerator(
      epochHash,
      (opts) => this.generate(opts),
    );
  }

  public addInclusionHash(block: BlockFact, outputIdx: number, hash: Hash) {
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
    block: BlockFact,
    // request: (
    //   contractHash: Hash,
    //   params: Uint8Array,
    // ) => MaybePromise<Uint8Array>,
    invert: (hash: Hash) => MaybePromise<Uint8Array>,
  ) {
    return true;
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
    if (epochBaseTime === 0n) {
      throw new Error(`Epoch base time hasn't been set yet!`);
    }
    request(
      timeHash,
      TimeParams.encode({
        time: epochBaseTime + height * epochIntervalMs,
      }),
    );

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
