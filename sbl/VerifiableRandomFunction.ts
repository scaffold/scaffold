import Hash from './util/Hash.ts';
import Context from './Context.ts';
import secp from './util/secp.ts';
import { hex2bin } from './pathUtils.ts';

// NOTE THAT THIS IS NOT A VRF
// THIS IMPLEMENTATION IS REALLY BAD
// IT WORKS FOR NOW BUT IT'S NOT SECURE AT ALL

// https://arxiv.org/pdf/2109.04911.pdf
// https://arxiv.org/pdf/2205.11878.pdf
// https://docs.sui.io/learn/cryptography/ecvrf
// https://github.com/yoseplee/vrf
// https://github.com/fcelda/nsec5-crypto
// https://github.com/google/draft-irtf-cfrg-vrf
// https://github.com/aergoio/secp256k1-vrf

interface VrfOutput {
  random: Hash;
  proof: Uint8Array;
}

export default class VerifiableRandomFunction {
  private entropy = hex2bin(
    // Just some random bytes
    'fe972dbb977858fbabb4b08bead31e6cd0e2afbafb81bc3f64e1d4c45eae921a',
  );

  constructor(private ctx: Context) {}

  public create(seed: Hash): VrfOutput {
    const sig = secp.sign(seed.toBytes(), this.ctx.config.selfPrivateKey, {
      lowS: true,
      extraEntropy: this.entropy,
    }).toCompactRawBytes();
    return { random: Hash.digest(sig), proof: sig };
  }

  public verify(output: VrfOutput, seed: Hash, publicKey: Uint8Array) {
    return Hash.equals(Hash.digest(output.proof), output.random) &&
      secp.verify(output.proof, seed.toBytes(), publicKey);
  }
}
