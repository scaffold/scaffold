import { ZERO_BLOCK } from './BlockMeta.ts';
import { BlockFact } from './FactMeta.ts';
import {
  Block,
  FrontierTreeIoBranch,
  FrontierTreeIoEntry,
  Verifier,
} from './messages.ts';
import { Hash, HASH_BITS, HashPrimitive } from './util/Hash.ts';
import { arrEquals } from './util/buffer.ts';
import { error, todo } from './util/functional.ts';
import { mapPut } from './util/map.ts';

export class FrontierHelper {
  public static mergeTreeIo(
    inputs: { block: BlockFact; outputIdx?: number }[],
    frontierVote: BlockFact | typeof ZERO_BLOCK,
    fetchBlock: (hash: Hash) => Block,
  ) {
    const consumedInputs = new Map<HashPrimitive, FrontierTreeIoBranch>();
    const producedOutputs = new Map<HashPrimitive, FrontierTreeIoBranch>();

    for (const input of inputs) {
      if (input.outputIdx !== input.block.frontierOutputIdx) {
        continue;
      }

      this.iterateBranches(
        input.block.frontierDetail.consumedInputsRoot,
        (branch) => {
          const key = Hash.digest(FrontierTreeIoBranch.encode(branch));
          if (!producedOutputs.delete(key.toPrimitive())) {
            mapPut(
              consumedInputs,
              key.toPrimitive(),
              () => branch,
              () => error(`This merge would double-spend an input!`),
            );
          }
        },
      );

      this.iterateBranches(
        input.block.frontierDetail.producedOutputsRoot,
        (branch) => {
          const key = Hash.digest(FrontierTreeIoBranch.encode(branch));
          if (!consumedInputs.delete(key.toPrimitive())) {
            mapPut(
              producedOutputs,
              key.toPrimitive(),
              () => branch,
              () => error(`This merge would doubly-create an output!`),
            );
          }
        },
      );

      for (const input2 of input.block.inputs) {
        const output2 = fetchBlock(input2.blockHash).outputs[input2.outputIdx];
        const branch = {
          path: this.encodePath(output2.verifier),
          childHash: input2.blockHash,
          outputIdx: input2.outputIdx,
          amount: output2.amount,
        };

        const key = Hash.digest(FrontierTreeIoBranch.encode(branch));
        if (!producedOutputs.delete(key.toPrimitive())) {
          mapPut(
            consumedInputs,
            key.toPrimitive(),
            () => branch,
            () => error(`This merge would double-spend an input!`),
          );
        }
      }

      let outputIdx = 0;
      for (const output2 of input.block.outputs) {
        const branch = {
          path: this.encodePath(output2.verifier),
          childHash: input.block.hash,
          outputIdx: outputIdx++,
          amount: output2.amount,
        };

        const key = Hash.digest(FrontierTreeIoBranch.encode(branch));
        if (!consumedInputs.delete(key.toPrimitive())) {
          mapPut(
            producedOutputs,
            key.toPrimitive(),
            () => branch,
            () => error(`This merge would doubly-create an output!`),
          );
        }
      }
    }

    for (const input of consumedInputs.values()) {
      if (
        frontierVote === ZERO_BLOCK || !this.doesOutput(frontierVote, input)
      ) {
        throw new Error(`Input does not exist!`);
      }
    }

    return {
      consumedInputsRoot: { branches: [...consumedInputs.values()] },
      producedOutputsRoot: { branches: [...producedOutputs.values()] },
    };
  }

  private static encodePath(verifier: Verifier) {
    return Hash.digest(Verifier.encode(verifier)).toBigint() ^
      (1n << BigInt(HASH_BITS));
  }

  private static doesOutput(
    block: BlockFact,
    branch: FrontierTreeIoBranch,
  ): boolean {
    if (
      block.frontierDetail.producedOutputsRoot.branches.some((x) =>
        x.path === branch.path && Hash.equals(x.childHash, branch.childHash) &&
        x.outputIdx === branch.outputIdx && x.amount === branch.amount
      ) ||
      (Hash.equals(block.hash, branch.childHash) &&
        block.outputs[branch.outputIdx].amount === branch.amount &&
        this.encodePath(block.outputs[branch.outputIdx].verifier) ===
          branch.path)
    ) {
      return true;
    } else if (
      block.frontierDetail.consumedInputsRoot.branches.some((x) =>
        x.path === branch.path && Hash.equals(x.childHash, branch.childHash) &&
        x.outputIdx === branch.outputIdx && x.amount === branch.amount
      ) || block.inputs.some((x) =>
        Hash.equals(x.blockHash, branch.childHash) &&
        x.outputIdx === branch.outputIdx
      )
    ) {
      return false;
    } else if (
      block.frontierVoteBlock === undefined ||
      block.frontierVoteBlock === ZERO_BLOCK
    ) {
      return false;
    } else {
      return this.doesOutput(block.frontierVoteBlock, branch);
    }
  }

  public static findOutputs(
    base: BlockFact,
    verifier: Verifier,
    onlyUnclaimed: boolean,
    verifierPath = this.encodePath(verifier),
  ): { blockHash: Hash; outputIdx: number; amount: bigint }[] {
    let outputs = base.frontierVoteBlock !== undefined &&
        base.frontierVoteBlock !== ZERO_BLOCK
      ? this.findOutputs(
        base.frontierVoteBlock,
        verifier,
        onlyUnclaimed,
        verifierPath,
      )
      : [];

    if (onlyUnclaimed) {
      outputs = outputs.filter((output) =>
        !base.frontierDetail.consumedInputsRoot.branches.some((x) =>
          x.path === verifierPath &&
          Hash.equals(x.childHash, output.blockHash) &&
          x.outputIdx === output.outputIdx && x.amount === output.amount
        ) && !base.inputs.some((x) =>
          Hash.equals(x.blockHash, output.blockHash) &&
          x.outputIdx === output.outputIdx
        )
      );
    }

    for (const branch of base.frontierDetail.producedOutputsRoot.branches) {
      if (branch.path === verifierPath) {
        outputs.push({
          blockHash: branch.childHash,
          outputIdx: branch.outputIdx,
          amount: branch.amount,
        });
      }
    }

    let outputIdx = 0;
    for (const output of base.outputs) {
      if (this.areVerifiersEqual(output.verifier, verifier)) {
        outputs.push({
          blockHash: base.hash,
          outputIdx,
          amount: output.amount,
        });
      }
      outputIdx++;
    }

    return outputs;
  }

  public static areVerifiersEqual(a: Verifier, b: Verifier) {
    return (
      Hash.equals(a.contractHash, b.contractHash) &&
      arrEquals(a.params, b.params)
    );
  }

  private static iterateBranches(
    entry: FrontierTreeIoEntry,
    cb: (branch: FrontierTreeIoBranch) => void,
  ) {
    for (const branch of entry.branches) {
      if (branch.outputIdx === -1) {
        // TODO: Process childHash as another FrontierTreeIoEntry
        // Child entries will need to be passed the parent path(s), so they can add it into their key hashes.
        todo();
      } else if (branch.outputIdx < 0) {
        throw new Error(`Invalid outputIdx: ${branch.outputIdx}`);
      } else {
        // Process as a block IO entry
        cb(branch);
      }
    }
  }
}
