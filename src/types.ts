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
  composeBlockPacket,
  composeGenesisPacket,
  composeUnsignedBlockPacket,
  createBlock,
  createBlockFromPacket,
  createGenesisBlock,
  getRefOutputs,
  RECORD_CONTRACT,
} from './core/Block.ts';
export {
  findRecordOutput,
  getRecordKey,
  isRecordOutput,
  makeRecordOutput,
} from './contracts/RecordContract.ts';
export type { BlockPayload } from './core/Block.ts';
export {
  PacketType,
  parsePacket,
  recoverPacketSigner,
  verifyPacketSignature,
} from './core/Packet.ts';
export type { Packet } from './core/Packet.ts';
export { AtomSource, AtomType } from './core/Atom.ts';
export type { Atom, AtomBase } from './core/Atom.ts';
export type { BlockSpec, Output, Verifier } from './core/BlockCreationModule.ts';
export type { BlockReceivedResult } from './core/Coordinator.ts';
