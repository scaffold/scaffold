import Context from './Context.ts';
import { Block } from './messages.ts';

export default class BlockMerger {
  constructor(private ctx: Context) {}

  public merge(blocks: Block[][]): Block[] {
  }
}
