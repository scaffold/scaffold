import { secp } from '../deps.ts';
import { Context } from './Context.ts';
import { Hash } from './util/Hash.ts';
import { arrConcat, EMPTY_ARR } from './util/buffer.ts';

// TODO: Make sure this is secure against birthday collisions by adding randomness into the shared key
const IV_LENGTH = 12;

export class CryptoHelper {
  constructor(private ctx: Context) {}

  public async encrypt(
    { plaintext, remotePublicKey, authenticatedData }: {
      plaintext: Uint8Array;
      remotePublicKey: Uint8Array;
      authenticatedData?: Uint8Array;
    },
  ) {
    const iv = this.ctx.config.entropyProvider.randomBytes(IV_LENGTH);
    const enc = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: authenticatedData ?? EMPTY_ARR },
      await this.getSharedKey(remotePublicKey),
      plaintext,
    );

    return arrConcat(iv, new Uint8Array(enc));
  }

  public async decrypt(
    { ciphertext, remotePublicKey, authenticatedData }: {
      ciphertext: Uint8Array;
      remotePublicKey: Uint8Array;
      authenticatedData?: Uint8Array;
    },
  ) {
    const iv = ciphertext.subarray(0, IV_LENGTH);
    if (iv.byteLength !== IV_LENGTH) {
      throw new Error(`Invalid iv length!`);
    }

    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: authenticatedData ?? EMPTY_ARR },
      await this.getSharedKey(remotePublicKey),
      ciphertext.subarray(IV_LENGTH),
    );
    return new Uint8Array(buf);
  }

  private getSharedKey(remotePublicKey: Uint8Array) {
    const sharedKey = Hash.digest(secp.getSharedSecret(
      this.ctx.config.selfPrivateKey,
      remotePublicKey,
    )).toBytes();

    return crypto.subtle.importKey(
      'raw',
      sharedKey,
      { 'name': 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }
}
