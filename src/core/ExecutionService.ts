import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore } from './Block.ts';
import { Output } from './BlockCreationModule.ts';
import { ExecutionModule, ExecutionProvider } from './ExecutionModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

/**
 * Collect the full extended output vector: own outputs + ALL anchor outputs.
 * Unlike the conflict/consensus extended vector which filters out claimed outputs,
 * this includes all outputs so that claim indices can reference them directly.
 */
function collectAllExtendedOutputs(block: Block, store: BlockStore): Output[] {
  const result: Output[] = [...block.outputs];
  if (Hash.equals(block.anchor, ZERO_HASH)) return result;

  const anchorBlock = store.get(block.anchor);
  if (!anchorBlock) return result;

  // For execution, we need the anchor's extended vector unfiltered
  const anchorOutputs = collectAllExtendedOutputs(anchorBlock, store);
  result.push(...anchorOutputs);
  return result;
}

class ExecutionProviderAdapter implements ExecutionProvider<Block> {
  constructor(private readonly store: BlockStore) {}

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getOutputs(block: Block): Output[] {
    return block.outputs;
  }

  getRefs(block: Block): Hash[] {
    return block.refs;
  }

  getClaims(block: Block): number[] {
    return block.claims;
  }

  getAnchor(block: Block): Hash {
    return block.anchor;
  }

  getExtendedOutputs(block: Block): Output[] {
    return collectAllExtendedOutputs(block, this.store);
  }

  getSigner(block: Block): Uint8Array | undefined {
    return block.signer;
  }

  getTimestamp(block: Block): number {
    return block.timestamp;
  }
}

/** ExecutionModule wired to BlockStore via ProtocolContext. */
export class ExecutionService extends ExecutionModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new ExecutionProviderAdapter(store));
  }
}
