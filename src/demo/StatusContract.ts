import { Hash } from '../util/Hash.ts';
import { Output } from '../core/BlockCreationModule.ts';

const SBL = Hash.fromLiteralStr('SBL'.padEnd(32, '\0'));

/** Contract hash for status outputs, following the SBL XOR convention. */
export const statusHash = Hash.xor(SBL, Hash.fromLiteralStr('status'));

/**
 * Output data format: [publicKey (33 bytes)] [UTF-8 message ...]
 */
export function encodeStatusData(publicKey: Uint8Array, message: string): Uint8Array {
  const msgBytes = new TextEncoder().encode(message);
  const data = new Uint8Array(33 + msgBytes.length);
  data.set(publicKey, 0);
  data.set(msgBytes, 33);
  return data;
}

export function decodeStatusData(data: Uint8Array): { publicKey: Uint8Array; message: string } {
  const publicKey = data.slice(0, 33);
  const message = new TextDecoder().decode(data.slice(33));
  return { publicKey, message };
}

export function makeStatusOutput(publicKey: Uint8Array, message: string): Output {
  return {
    verifier: { contract: statusHash, params: new Uint8Array(0) },
    value: 1,
    data: encodeStatusData(publicKey, message),
  };
}
