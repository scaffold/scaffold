import BlockService from './BlockService.ts';
import Context from './Context.ts';
import { BlockInput, BlockOutput, BlockSet, Verifier } from './messages.ts';
import { arrCompare, arrEquals } from './util/buffer.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';

// BlockSets help with the core problem; mergability.

export default class BlockSetVerifier {
  constructor(private ctx: Context) {}

  public async generateBlockSet(
    baseBlocks: Hash[],
    frontierBlocks: Hash[],
  ): Promise<BlockSet> {
    const baseBlockSet = new Set(baseBlocks.map((hash) => hash.toPrimitive()));

    const inputs: Map<HashPrimitive, BlockInput> = new Map();
    const addInput = (input: BlockInput) =>
      getOrCreate(inputs, input.block_hash.toPrimitive(), () => input, (x) => {
        x.amount += input.amount;
        return x;
      });

    const outputs: Map<HashPrimitive, BlockOutput> = new Map();
    const addOutput = (output: BlockOutput) =>
      getOrCreate(
        outputs,
        Hash.digest(Verifier.encode(output.verifier)).toPrimitive(),
        () => output,
        (x) => {
          x.amount += output.amount;
          return x;
        },
      );

    const iteratingHashes: Set<HashPrimitive> = new Set();
    const iterateBlockHash = async (hash: Hash): Promise<void> => {
      const key = hash.toPrimitive();
      if (iteratingHashes.has(key)) {
        return;
      }
      iteratingHashes.add(key);

      const block = await this.ctx.get(BlockService).get(hash);
      block.outputs.forEach(addOutput);
      const promises = block.inputs.map((input) => {
        if (baseBlockSet.has(input.block_hash.toPrimitive())) {
          // Don't descend
          addInput(input);
        } else {
          // We're consuming an output from the sub-block
          addOutput({ verifier: block.verifier, amount: input.amount });
          return iterateBlockHash(input.block_hash);
        }
      });

      await Promise.all(promises);
    };

    const promises = frontierBlocks.map(iterateBlockHash);
    await Promise.all(promises);

    return {
      // TODO: Sort better
      inputs: [...inputs.values()].sort((a, b) =>
        arrCompare(BlockInput.encode(a), BlockInput.encode(b))
      ),
      outputs: [...outputs.values()].sort((a, b) =>
        arrCompare(BlockOutput.encode(a), BlockOutput.encode(b))
      ),
      frontier: frontierBlocks,
    };
  }

  public async verify(blockSet: BlockSet) {
    const testSet = await this.generateBlockSet(
      blockSet.inputs.map((x) => x.block_hash),
      blockSet.frontier,
    );

    if (!arrEquals(BlockSet.encode(blockSet), BlockSet.encode(testSet))) {
      console.error(blockSet, testSet);
      throw new Error(`BlockSet doesn't validate!`);
    }
  }
}
