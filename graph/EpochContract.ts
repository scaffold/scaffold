import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import * as epochMessages from './epochMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import * as timeMessages from './timeMessages.ts';
import TimeContract from './TimeContract.ts';

const epochIv = Hash.fromHex(
  'd2e66375ccb9e7c2ccdf5ef538a78f010d34aa3b4c7802837da358e833441c7e',
).toBytes();

const epochBaseTime = BigInt((() => {
  // This is temporary, for easy development.
  // Eventually the base time will be fixed.
  const hour = 1000 * 60 * 60;
  return Math.floor(Date.now() / hour) * hour;
})());
// const epochBaseTime = BigInt(new Date('2022-04-22T18:40:00-0700').getTime());
const epochIntervalMs = 1000n;

// Also verify that the block isn't too big.

export default class EpochContract {
  constructor(private ctx: Context) {}

  public timeToHeight(time: number) {
    if (time > epochBaseTime) {
      return (BigInt(time) - epochBaseTime) / epochIntervalMs;
    } else {
      return 0n;
    }
  }

  public get() {
    const timeContractHash = this.ctx.get(TimeContract).get().hash;

    const epochGenerator = (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      const { height } = epochMessages.Params.decode(params);

      const priorHash = Hash.digest(
        height
          ? request(
            contractHash,
            epochMessages.Params.encode({ height: height - 1n }),
          )
          : epochIv,
      );
      const skipHash = Hash.digest(
        height
          ? request(
            contractHash,
            epochMessages.Params.encode({ height: height & (height - 1n) }),
          )
          : epochIv,
      );
      const eventsHash = Hash.digest(new Uint8Array([]));

      if (!emitCorrect) {
        priorHash.toBytes()[Math.floor(Math.random() * 32)] ^= 1;
      }

      // Wait for time
      request(
        timeContractHash,
        timeMessages.Params.encode({
          time: epochBaseTime + height * epochIntervalMs,
        }),
      );

      return epochMessages.Answer.encode({
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
    (window as any).epochMessages = epochMessages;
    (window as any).epochIv = epochIv;
    (window as any).epochBaseTime = epochBaseTime;
    (window as any).epochIntervalMs = epochIntervalMs;
    (window as any).timeContractHash = timeContractHash;

    const contract = this.ctx.get(GraphUtils).supplyContract(epochContract);
    this.ctx.get(GraphUtils).supplyGenerator(contract, epochGenerator);

    return contract;
  }
}
