import { RedBlackTree } from 'std-latest/collections/red_black_tree.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import Context from './Context.ts';

export default class DerivedWorkService {
  private samples: BlockExt[] = [];

  constructor(private ctx: Context) {
    ctx.config.timeProvider.setInterval(() => {
      if (this.samples.length) {
        this.propagate();
      }
    }, 1000);
    // TODO: Destruct
  }

  public addSample(block: BlockExt) {
    this.samples.push(block);
    if (this.samples.length === 32) {
      this.propagate();
    }
  }

  private propagate() {
    const queue: RedBlackTree<BlockExt> = new RedBlackTree((a, b) =>
      a.timestamp !== b.timestamp
        ? Number(a.timestamp - b.timestamp)
        : a.nonce - b.nonce
    );

    const workAmts = this.samples.map((s, idx) => {
      s.propagationMask = 1 << idx;
      queue.insert(s);

      return Number(this.ctx.get(BlockService).getWork(s));
    });

    while (true) {
      const entry = queue.max();
      if (!entry) {
        break;
      }
      queue.remove(entry);

      entry.derivedWork += workAmts.reduce(
        (acc, amt, idx) => entry.propagationMask & (1 << idx) ? acc + amt : acc,
        0,
      );

      entry.inputs.forEach(({ block_hash }) => {
        const child = this.ctx.get(BlockService).get(block_hash);
        if (child) {
          child.propagationMask |= entry.propagationMask;
          queue.insert(child);
        }
      });

      entry.propagationMask = 0;
    }

    this.samples = [];
  }
}
