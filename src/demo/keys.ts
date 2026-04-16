import { Hash } from '../util/Hash.ts';
import { secp } from '../util/secp.ts';
import { composeGenesisPacket } from '../core/Packet.ts';
import { makeSignatureOutput } from '../contracts/SignatureContract.ts';
import { Block } from '../core/Block.ts';

export interface DemoKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function deriveKey(seed: string): DemoKey {
  const privateKey = Hash.digest(seed).toBytes();
  const publicKey = secp.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

export const DEMO_ALICE = deriveKey('scaffold:demo:alice');
export const DEMO_BOB = deriveKey('scaffold:demo:bob');
export const DEMO_CHARLIE = deriveKey('scaffold:demo:charlie');

/**
 * Create a genesis block distributing 1M value to each demo key.
 * Use this for demos that need economic balances.
 */
export function createDemoGenesis(): Block {
  const outputs = [
    makeSignatureOutput(DEMO_ALICE.publicKey, 1_000_000),
    makeSignatureOutput(DEMO_BOB.publicKey, 1_000_000),
    makeSignatureOutput(DEMO_CHARLIE.publicKey, 1_000_000),
  ];
  return composeGenesisPacket(outputs).block;
}
