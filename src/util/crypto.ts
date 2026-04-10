import { Hash } from './Hash.ts';

const IV_LENGTH = 12;

/** Derive an AES-GCM key from a raw ECDH shared secret. */
export async function deriveAesKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
  const keyBytes = Hash.digest(sharedSecret).toBytes();
  return crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** AES-GCM encrypt. Returns ciphertext and IV. */
export async function encryptSignal(
  plaintext: Uint8Array,
  key: CryptoKey,
): Promise<{ encrypted: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    plaintext.buffer as ArrayBuffer,
  );
  return { encrypted: new Uint8Array(buf), iv };
}

/** AES-GCM decrypt. */
export async function decryptSignal(
  encrypted: Uint8Array,
  iv: Uint8Array,
  key: CryptoKey,
): Promise<Uint8Array> {
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encrypted.buffer as ArrayBuffer,
  );
  return new Uint8Array(buf);
}

// -- Base64 helpers for wire format ------------------------------------

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
