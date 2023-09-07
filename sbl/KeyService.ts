import secp from './util/secp.ts';
import Context from './Context.ts';
import PublicKeyService from '~/sbl/PublicKeyService.ts';

export default class KeyService {
  private selfPublicKey: Uint8Array;

  constructor(private ctx: Context) {
    this.selfPublicKey = secp.getPublicKey(ctx.config.selfPrivateKey);
    if (this.selfPublicKey.byteLength !== 33) {
      throw new Error(
        `Invalid public key length: ${this.selfPublicKey.byteLength}`,
      );
    }
    ctx.get(PublicKeyService).addPublicKey(this.selfPublicKey);
  }

  public getSelfPublicKey() {
    return this.selfPublicKey;
  }

  public static makeRandomPublicKey() {
    const data = new Uint8Array(33);
    crypto.getRandomValues(data);
    return data;
  }
}
