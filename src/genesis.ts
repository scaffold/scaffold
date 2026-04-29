/**
 * Well-known genesis block for testnet/demo use.
 *
 * The keypair is derived deterministically from Hash.digest('scaffold:testnet').
 * The genesis block contains a single signature output with 1,000,000 value
 * spendable by the well-known key.
 *
 * WARNING: This key is PUBLIC -- suitable for testnet/demos only.
 */

import { secp } from './util/secp.ts';
import { Hash } from './util/Hash.ts';
import { hex2bin } from './util/hex.ts';
import { Block, composeGenesisPacket, parseBlockPacket } from './core/Block.ts';
import { AtomSource } from './core/Atom.ts';
import { makeSignatureOutput } from './contracts/SignatureContract.ts';

/** Well-known private key: first 32 bytes of Hash.digest('scaffold:testnet'). */
export const WELL_KNOWN_PRIVATE_KEY: Uint8Array = Hash.digest('scaffold:testnet').toBytes();

/** Well-known public key (33-byte compressed secp256k1). */
export const WELL_KNOWN_PUBLIC_KEY: Uint8Array = secp.getPublicKey(WELL_KNOWN_PRIVATE_KEY, true);

// Pre-computed genesis packet hex. Regenerate with: deno task generate-genesis
// deno-lint-ignore no-inferrable-types
let GENESIS_PACKET_HEX: string =
  '534346017b22616e63686f72223a7b225f5f74223a2248222c2276223a2230303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030227d2c2261676772656761746573223a5b5d2c22636c61696d73223a5b5d2c226f757470757473223a5b7b227665726966696572223a7b22636f6e7472616374223a7b225f5f74223a2248222c2276223a2239343431613035616430316138623231343934333633336535376333633064336564386165373761643566663065633163323039383834616235336233346465227d2c22706172616d73223a7b225f5f74223a2242222c2276223a22416d49354839433632374b744e623653694c743259422f6971746f56704553625a6e616e78484a616673626c227d7d2c2276616c7565223a313030303030302c2264657461696c223a7b225f5f74223a2242222c2276223a22227d7d5d2c226465636c61726564576569676874223a393030373139393235343734303939312c2272656673223a5b5d2c2274696d657374616d70223a307d';

/** Get the well-known genesis block. Computes from outputs if hex is empty. */
export function getGenesisBlock(): Block {
  if (GENESIS_PACKET_HEX) {
    const block = parseBlockPacket(hex2bin(GENESIS_PACKET_HEX), AtomSource.Local);
    if (!block) throw new Error('Failed to parse genesis packet');
    return block;
  }
  return computeGenesisBlock();
}

/** Compute the genesis block from scratch (not from hex). */
export function computeGenesisBlock(): Block {
  const outputs = [makeSignatureOutput(WELL_KNOWN_PUBLIC_KEY, 1_000_000)];
  return composeGenesisPacket(outputs);
}

/** Set the genesis hex (called by generate_genesis or at module load). */
export function setGenesisHex(hex: string): void {
  GENESIS_PACKET_HEX = hex;
}

// -- Demo helpers --------------------------------------------------
//
// Deterministic keypairs for the request/reply CLI demo. Each "seed" maps
// to a stable private key so every node computes the same genesis when
// given the same seed list.

/** Derive a deterministic demo private key from a short string seed. */
export function demoPrivateKey(seed: string): Uint8Array {
  return Hash.digest(`scaffold:demo:${seed}`).toBytes();
}

/** Compressed secp256k1 public key for a demo seed. */
export function demoPublicKey(seed: string): Uint8Array {
  return secp.getPublicKey(demoPrivateKey(seed), true);
}

/**
 * Compute a demo genesis that funds the given seed list with 1M each.
 * Does NOT include the well-known key -- demos are self-contained.
 * Every node passing the same seeds in the same order computes the
 * identical genesis block.
 */
export function computeDemoGenesis(seeds: readonly string[]): Block {
  const outputs = seeds.map((seed) => makeSignatureOutput(demoPublicKey(seed), 1_000_000));
  return composeGenesisPacket(outputs);
}
