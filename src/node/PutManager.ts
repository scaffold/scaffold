import { Hash } from "../util/Hash.ts";
import { Block } from "../core/Block.ts";
import { BlockSpec, ClaimEntry, Output } from "../core/BlockCreationModule.ts";

/** Request to put data into the network */
export interface PutRequest {
  /** Outputs to include in the block */
  outputs: Output[];
  /** Optional: anchor block hash. When provided, overrides the default pending anchor. */
  anchor?: Hash;
  /** Optional: user-specified claims to include in the block */
  claims?: ClaimEntry[];
  /** Optional: claim to satisfy a verifier (the incentive block hash) */
  satisfies?: Hash;
  /** Optional: declared weight for the block */
  declaredWeight?: number;
}

/** Result of a put operation */
export interface PutResult {
  /** Hash of the created block */
  hash: Hash;
  /** The created block */
  block: Block;
}

/** Interface for building and processing blocks */
export interface BlockProcessor {
  /** Build a block from a spec */
  buildBlock(spec: BlockSpec): Block | null;
  /** Process a block through the reactive layer */
  processBlock(block: Block): void;
}

export class PutManager {
  private readonly processor: BlockProcessor;

  constructor(processor: BlockProcessor) {
    this.processor = processor;
  }

  /** Create and submit a block from a put request */
  put(request: PutRequest): PutResult {
    const claims: ClaimEntry[] = [...(request.claims ?? [])];

    if (request.satisfies) {
      claims.push({ index: 0, value: 0 });
    }

    const spec: BlockSpec = {
      anchor: request.anchor ?? Hash.digest("pending"),
      outputs: request.outputs,
      claims,
      declaredWeight: request.declaredWeight ?? 1,
      aggregates: [],
      refs: [],
    };

    const block = this.processor.buildBlock(spec);

    if (!block) {
      throw new Error("Failed to build block from put request");
    }

    this.processor.processBlock(block);

    return {
      hash: block.hash,
      block,
    };
  }
}
