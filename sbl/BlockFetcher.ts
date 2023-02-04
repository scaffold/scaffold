import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { Block, RequestBlockMessage, Verifier } from './messages.ts';
import NodeService from './NodeService.ts';
import { BlockRegistry } from './registries.ts';
import { arrEquals } from './util/buffer.ts';

const rewardPrefix = new TextEncoder().encode('SBL.BASE'.padEnd(28, '\0'));

export default class BlockFetcher {
  // TODO: Cleanup this set periodically
  private fetching: Set<string> = new Set();

  constructor(private ctx: Context) {}

  public get(hash: Hash): Block | Promise<Block> {
    if (arrEquals(hash.toBytes().subarray(0, 28), rewardPrefix)) {
      const b3 = hash.toBytes()[28] << 24;
      const b2 = hash.toBytes()[29] << 16;
      const b1 = hash.toBytes()[30] << 8;
      const b0 = hash.toBytes()[31] << 0;
      const epoch = b3 | b2 | b1 | b0;
      return {
        inputs: [{ block_hash: Hash.fromLiteral32(0), amount: 1n }],
        outputs: [],
        verifier: {
          contract_hash: Hash.fromLiteral32(0),
          params: new Uint8Array(),
        },
        body: new Uint8Array(),
        isFreeMarket: true,
        timestamp: 123n,
      };
    }

    const block = this.ctx.get(BlockRegistry).getOrWait(hash);
    if (block instanceof Promise) {
      const key = hash.toHex();
      if (!this.fetching.has(key)) {
        this.fetching.add(key);
        this.ctx.get(NodeService).getAll().forEach((node) =>
          node.defaultConn?.sendReliable({ RequestBlockMessage: { hash } })
        );
      }
    }
    return block;
  }
}
