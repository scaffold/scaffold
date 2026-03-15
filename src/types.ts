/**
 * Shared type re-exports for the Scaffold library.
 *
 * Import from here for public-facing types rather than reaching
 * into core/ or util/ directly.
 */

export { Hash, type HashPrimitive, ZERO_HASH } from './util/Hash.ts';
export type { Block } from './core/Block.ts';
export {
  BlockStore,
  createBlock,
  createBlockFromPacket,
  createGenesisBlock,
  createSelfClaimedOutput,
  findSelfClaimedOutput,
  getRefOutputs,
  getSelfClaimKey,
  isSelfClaimed,
  SELF_CONTRACT,
} from './core/Block.ts';
export type { BlockPayload } from './core/Block.ts';
export {
  composeBlockPacket,
  composeGenesisPacket,
  composeUnsignedBlockPacket,
  PacketType,
  parsePacket,
  recoverPacketSigner,
  verifyPacketSignature,
} from './core/Packet.ts';
export type { Packet } from './core/Packet.ts';
export type { BlockBlueprint, BlockSpec, Output, Verifier } from './core/BlockCreationModule.ts';
export { BitVector } from './core/BitVector.ts';
export type { BlockReceivedResult } from './core/Coordinator.ts';
