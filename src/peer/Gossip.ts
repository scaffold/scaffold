import { Block } from '../graph/types.ts';

export class Gossip {
  fromConnections = new WeakMap<Block, string[]>();
  toConnections = new WeakMap<Block, Set<string>>();
}
