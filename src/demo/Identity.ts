import { Hash } from '../util/Hash.ts';
import { secp } from '../util/secp.ts';

export const ANIMALS = [
  'antelope', 'badger', 'crane', 'dolphin', 'eagle',
  'falcon', 'gecko', 'hawk', 'ibis', 'jackal',
] as const;

export type AnimalName = typeof ANIMALS[number];

export interface Identity {
  name: AnimalName;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Derive a deterministic identity from an animal name.
 * privateKey = Hash.digest('scaffold:' + name).toBytes()  (32 bytes)
 * publicKey  = secp.getPublicKey(privateKey, true)         (33 bytes, compressed)
 */
export function deriveIdentity(name: AnimalName): Identity {
  const privateKey = Hash.digest('scaffold:' + name).toBytes();
  const publicKey = secp.getPublicKey(privateKey, true);
  return { name, privateKey, publicKey };
}
