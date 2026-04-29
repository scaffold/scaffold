/**
 * Deterministically build a genesis block from a UserKey pool. Only users
 * with balance > 0 get a signature output. Zero-balance "new users" exist
 * as keypairs in the pool but do not appear in genesis.
 */

import type { Block, BlockPayload } from '../src/core/Block.ts';
import { AtomSource, composeGenesisPacket, createBlockFromPacket } from '../src/core/Block.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { PacketType, parsePacket } from '../src/core/Packet.ts';
import { bin2hex, hex2bin } from '../src/util/hex.ts';
import type { UserKey } from './types.ts';

export interface HarnessGenesis {
  block: Block;
  /** Hex-encoded raw packet bytes, safe to write to disk or env. */
  packetHex: string;
}

export function buildHarnessGenesis(users: readonly UserKey[]): HarnessGenesis {
  const outputs = [];
  for (const u of users) {
    if (u.balance <= 0) continue;
    outputs.push(makeSignatureOutput(u.publicKey, u.balance));
  }
  const block = composeGenesisPacket(outputs);
  return { block, packetHex: bin2hex(block.raw) };
}

export function loadGenesisFromHex(hex: string): Block {
  const raw = hex2bin(hex);
  const packet = parsePacket<BlockPayload>(raw);
  if (!packet) throw new Error('failed to parse genesis packet hex');
  return createBlockFromPacket(
    packet.payload,
    packet.raw,
    packet.hash,
    PacketType.JsonUnsignedBlock,
    AtomSource.Local,
  );
}
