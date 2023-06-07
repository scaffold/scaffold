import Hash from './util/Hash.ts';
import Context from './Context.ts';
import secp from './util/secp.ts';
import { hex2bin } from './pathUtils.ts';

// NOTE THAT THIS IS NOT A VRF
// THIS IMPLEMENTATION IS REALLY BAD
// IT WORKS FOR NOW BUT IT'S NOT SECURE AT ALL

interface VrfOutput {
  random: Hash;
  proof: Uint8Array;
}

export default class VerifiableRandomFunction {
  private entropy = hex2bin(
    // Just some random bytes
    '8a2f2c1bae00e67edadd62e6cec2dac2f3ca1d6048ff3d9c6140416aa61663d9',
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
