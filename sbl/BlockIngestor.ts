import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { Block, BlockInput, BlockOutput, Verifier } from './messages.ts';
import {
  BlockRegistry,
  FulfillmentRegistry,
  GeneratorRegistry,
  IncentiveRegistry,
} from './registries.ts';
import { RedBlackTree } from 'std-latest/collections/red_black_tree.ts';
import Counter from './util/Counter.ts';
import { arrEquals } from './util/buffer.ts';
import BlockFetcher from './BlockFetcher.ts';
import AccountContract from '../graph/AccountContract.ts';
import IncentiveCalculator from './IncentiveCalculator.ts';
import GraphUtils from './GraphUtils.ts';

export default class BlockIngestor {
  private ingesting: Set<string> = new Set();

  constructor(private ctx: Context) {}

  public async ingest(block: Block) {
    const verifierHash = Hash.digest(Verifier.encode(block.verifier));
    this.ctx.get(FulfillmentRegistry).getOrCreate(
      verifierHash,
      () => [block],
      (arr) => {
        arr.push(block);
        return arr;
      },
    );

    if (
      Hash.equals(
        block.verifier.contract_hash,
        this.ctx.get(GraphUtils).getGeneratorContract(),
      )
    ) {
      this.ctx.get(GeneratorRegistry).getOrCreate(
        Hash.fromBytes(block.verifier.params),
        () => [block],
        (arr) => {
          arr.push(block);
          return arr;
        },
      );
    }

    const block_hash = this.hashBlock(block);
    if (!this.ingesting.has(block_hash.toHex())) {
      this.ingesting.add(block_hash.toHex());

      this.checkZeroSum(block);
      await Promise.all([
        this.checkBlockTimestamp(block),
        this.checkBlockMergability(block),
      ]);

      this.ctx.get(BlockRegistry).getOrCreate(block_hash, () => block, () => {
        throw new Error('ALREADY_EXISTS');
      });

      block.outputs.forEach((output) => {
        const verifier_hash = Hash.digest(Verifier.encode(output.verifier));
        const input = { block_hash, amount: output.amount };
        this.ctx.get(IncentiveRegistry).getOrCreate(
          verifier_hash,
          () => ({ verifier: output.verifier, inputs: [input] }),
          (entry) => {
            entry.inputs.push(input);
            return entry;
          },
        );
      });

      this.ingesting.delete(block_hash.toHex());
    }

    return block_hash;
  }

  private hashBlock(block: Block) {
    return Hash.digest(Block.encode(block));
  }

  private checkZeroSum(block: Block) {
    let sum = this.ctx.get(IncentiveCalculator)
      .getAvailableIncentive(block.verifier, block.inputs);
    block.outputs.forEach(({ amount }) => sum += amount);
    if (sum !== 0n) {
      throw new Error('INVALID_COIN_SUM');
    }
  }

  private async checkBlockTimestamp(block: Block) {
    const verifications = block.inputs.map(async (claim) => {
      const parent = await this.ctx.get(BlockFetcher).get(claim.block_hash);
      if (block.timestamp <= parent.timestamp) {
        throw new Error('INVALID_TIMESTAMP');
      }
    });
    await Promise.all(verifications);
  }

  private async checkBlockMergability(block: Block) {
    const counts = new Counter<bigint>();
    const outputs = new Set<BlockOutput>();
    const queue: RedBlackTree<{ hash: Hash; block: Block; claimMask: bigint }> =
      new RedBlackTree((a, b) =>
        a.block.timestamp > b.block.timestamp
          ? 1
          : a.block.timestamp < b.block.timestamp
          ? -1
          : Hash.cmp(a.hash, b.hash)
      );
    const addClaim = async (
      { block_hash, amount }: BlockInput,
      verifier: Verifier,
      claimMask: bigint,
    ) => {
      const block = await this.ctx.get(BlockFetcher).get(block_hash);
      const output = block.outputs.find((output) =>
        output.amount === amount &&
        Hash.equals(output.verifier.contract_hash, verifier.contract_hash) &&
        arrEquals(output.verifier.params, verifier.params)
      );
      if (!output) {
        throw new Error('INVALID_CLAIM');
      }
      if (outputs.has(output)) {
        throw new Error('DOUBLE_SPEND');
      }
      outputs.add(output);
      const entry = { hash: block_hash, block, claimMask };
      if (queue.insert(entry)) {
        counts.inc(claimMask);
      } else {
        const found = queue.find(entry)!;
        const oldClaimMask = found.claimMask;
        found.claimMask |= entry.claimMask;
        if (found.claimMask !== oldClaimMask) {
          counts.dec(oldClaimMask);
          counts.inc(found.claimMask);
        }
      }
    };

    await Promise.all(
      block.inputs.map((input, idx) =>
        addClaim(input, block.verifier, 1n << BigInt(idx))
      ),
    );

    while (!queue.isEmpty && counts.count() > 1) {
      const entry = queue.max()!;
      queue.remove(entry);
      counts.dec(entry.claimMask);

      await Promise.all(
        entry.block.inputs.map((input) =>
          addClaim(input, entry.block.verifier, entry.claimMask)
        ),
      );
    }
  }
}
