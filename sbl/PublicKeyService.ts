import Context from './Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import secp from '~/sbl/util/secp.ts';

export default class PublicKeyService {
  private keys = new Map<HashPrimitive, Uint8Array>();

  constructor(private ctx: Context) {}

  public addPublicKey(key: Uint8Array) {
    this.keys.set(Hash.digest(key).toPrimitive(), key);
  }

  // TODO: I don't think we need this
  // public findSigner(signature: Uint8Array, msgHash: Hash) {
  //   for (const [_hash, key] of this.keys) {
  //     if (secp.verify(signature, msgHash.toBytes(), key)) {
  //       return key;
  //     }
  //   }
  // }
}
