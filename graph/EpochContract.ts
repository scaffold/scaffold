import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import { EpochAnswer, EpochParams } from './epochMessages.ts';

const baseMs = 1642476485983;
const epochsPerMs = 1 / 1000;

// Also verify that the block isn't too big.

const IV = new TextEncoder().encode('Job 13:15');

export default class EpochContract {
  constructor(private ctx: Context) {}

  public makeParams(height: bigint): Uint8Array {
    return EpochParams.encode((size) => new Uint8Array(size), { height });
  }

  public apply() {
    const hash = this.getContractHash('epoch');

    const func = (
      params: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      correct: boolean,
    ): Uint8Array => {
      const { height }: { height: bigint } = EpochParams.decode(params);

      const priorHash = Hash.digest(
        height ? request(hash, this.makeParams(height - 1n)) : IV,
      );
      const skipHash = Hash.digest(
        height ? request(hash, this.makeParams(height & (height - 1n))) : IV,
      );
      const eventsHash = Hash.digest(new Uint8Array([]));

      if (!correct) {
        priorHash.toBytes()[Math.floor(Math.random() * 32)] ^= 1;
      }

      return EpochAnswer.encode((size) => new Uint8Array(size), {
        prior_hash: priorHash,
        skip_hash: skipHash,
        events_hash: eventsHash,
      });
    };

    this.ctx.config.contracts.push({
      hash,
      func: (
        params: Uint8Array,
        answer: Uint8Array,
        request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) => arrEquals(func(params, request, true), answer),
    });

    this.ctx.config.generators.push({
      contractHash: hash,
      isCorrect: true,
      func: (
        params: Uint8Array,
        request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) => func(params, request, true),
    });

    this.ctx.config.generators.push({
      contractHash: hash,
      isCorrect: false,
      func: (
        params: Uint8Array,
        request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) => func(params, request, false),
    });
  }

  private getContractHash(name: string) {
    const hash = Hash.digest(name);
    console.log(
      `Special contract with hash ${hash.toHex()} is ${name}`,
    );
    return hash;
  }
}
