import secp from './util/secp.ts';
import Context from './Context.ts';

export default class KeyService {
  private selfPublicKey: Uint8Array;

  constructor(private ctx: Context) {
    this.selfPublicKey = secp.getPublicKey(ctx.config.selfPrivateKey);
    if (this.selfPublicKey.byteLength !== 33) {
      throw new Error(
        `Invalid public key length: ${this.selfPublicKey.byteLength}`,
      );
    }
  }

  public getSelfPublicKey() {
    return this.selfPublicKey;
  }
}
