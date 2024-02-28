import { secp } from '../deps.ts';
import { Context } from './Context.ts';
import { Hash } from './util/Hash.ts';
import { arrConcat } from './util/buffer.ts';
import { bin2hex } from './util/hex.ts';

// TODO: Implement this

const IV_LENGTH = 16;

export class CryptoHelper {
  constructor(private ctx: Context) {}

  public async encrypt(data: Uint8Array, remotePublicKey: Uint8Array) {
    const sharedKey = Hash.digest(secp.getSharedSecret(
      this.ctx.config.selfPrivateKey,
      remotePublicKey,
    )).toBytes();

    const key = await crypto.subtle.importKey(
      'raw',
      sharedKey,
      { 'name': 'AES-GCM' },
      false,
      ['encrypt'],
    );

    const iv = this.ctx.config.entropyProvider.randomBytes(IV_LENGTH);
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

    return arrConcat(iv, new Uint8Array(enc));
  }

  public async decrypt(data: Uint8Array, remotePublicKey: Uint8Array) {
    const iv = data.subarray(0, IV_LENGTH);
    if (iv.byteLength !== IV_LENGTH) {
      throw new Error(`Invalid iv length!`);
    }

    const sharedKey = Hash.digest(secp.getSharedSecret(
      this.ctx.config.selfPrivateKey,
      remotePublicKey,
    )).toBytes();

    const key = await crypto.subtle.importKey(
      'raw',
      sharedKey,
      { 'name': 'AES-GCM' },
      false,
      ['decrypt'],
    );

    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data.subarray(IV_LENGTH),
    );
    return new Uint8Array(buf);
  }
}
