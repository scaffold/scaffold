import { Prng, randomSeeded } from '@std/random';
import { EntropyProvider } from '../src/Config.ts';

export class SeededEntropyProvider implements EntropyProvider {
  private rng: Prng;

  constructor(seed: bigint) {
    this.rng = randomSeeded(seed);
  }

  randomNumber() {
    return this.rng();
  }

  randomBytes(size: number) {
    const arr = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      arr[i] = Math.floor(this.rng() * 256);
    }
    return arr;
  }
}
