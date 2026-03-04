/**
 * Shared type re-exports for the Scaffold library.
 *
 * Import from here for public-facing types rather than reaching
 * into core/ or util/ directly.
 */

export { Hash, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
export type { Block } from './core/Block.ts';
export { BlockStore, createBlock, createGenesisBlock } from './core/Block.ts';
export type { BlockBlueprint, BlockSpec, Output } from './core/BlockCreationModule.ts';
export { BitVector } from './core/BitVector.ts';
export type { BlockReceivedResult } from './core/Coordinator.ts';
