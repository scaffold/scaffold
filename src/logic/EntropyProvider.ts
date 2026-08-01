export interface EntropyProvider {
  randomNumber(): number;
  cryptoRandomBytes(size: number): Uint8Array;
}
