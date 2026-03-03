import { Block } from '../src/core/Block.ts';

/** Metadata tracked per block across the visualization. */
export interface BlockInfo {
  block: Block;
  creator: number; // index into NODE_NAMES
  depth: number;
  seqNum: number; // per-creator sequence number
}

/** A message in flight between two nodes. */
export interface InFlightMessage {
  block: Block;
  from: number; // node index
  to: number; // node index
  departTick: number;
  arriveTick: number;
}
