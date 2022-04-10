import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import { EpochAnswer, EpochParams } from './epochMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';

const baseMs = 1642476485983;
const epochsPerMs = 1 / 1000;

// Also verify that the block isn't too big.

const IV = Hash.fromHex(
  'd2e66375ccb9e7c2ccdf5ef538a78f010d34aa3b4c7802837da358e833441c7e',
).toBytes();

export default class EpochContract {
  constructor(private ctx: Context) {}

  public makeParams(height: bigint): Uint8Array {
    return EpochParams.encode({ height });
  }

  public get() {
    const epochGenerator = (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      const { height } = EpochParams.decode(params);

      const priorHash = Hash.digest(
        height
          ? request(contractHash, EpochParams.encode({ height: height - 1n }))
          : IV,
      );
      const skipHash = Hash.digest(
        height
          ? request(
            contractHash,
            EpochParams.encode({ height: height & (height - 1n) }),
          )
          : IV,
      );
      const eventsHash = Hash.digest(new Uint8Array([]));

      if (!emitCorrect) {
        priorHash.toBytes()[Math.floor(Math.random() * 32)] ^= 1;
      }

      return EpochAnswer.encode({
        prior_hash: priorHash,
        skip_hash: skipHash,
        events_hash: eventsHash,
      });
    };

    const epochContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      // Just run the generator and check it equals the candidate answer.
      arrEquals(
        epochGenerator(contractHash, params, true, request),
        request(contractHash, params),
      );

    // This is a nasty hack until we get WASM working
    (window as any).epochGenerator = epochGenerator;
    (window as any).EpochParams = EpochParams;
    (window as any).EpochAnswer = EpochAnswer;

    const contract = this.ctx.get(GraphUtils).supplyContract(epochContract);
    this.ctx.get(GraphUtils).supplyGenerator(contract, epochGenerator);

    return contract;
  }
}
