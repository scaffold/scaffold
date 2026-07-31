import { Context } from '../Context.ts';
import { arrCall } from '../util/array.ts';
import { bin2str, str2bin } from '../util/buffer.ts';
import { assert, todo } from '../util/functional.ts';
import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { taggedParse, taggedStringify } from '../util/json.ts';
import { mapPut, multimapPut } from '../util/map.ts';
import { BlockStore } from './BlockStore.ts';
import { ClaimIndexService } from './ClaimIndexService.ts';
import {
  Atom,
  AtomBase,
  AtomType,
  Block,
  BlockActionType,
  BlockPayload,
  BlockRef,
  isBlockPayload,
  OutputResolverType,
  ResolvingClaim,
  ResolvingRef,
} from './types.ts';

export interface Ingestor<AtomType extends Atom> {
  readonly isSigned: boolean;

  serialize(payload: AtomType['payload'], allocator: (size: number) => Uint8Array): Uint8Array;
  deserialize(base: AtomBase, ref?: BlockRef): AtomType;

  ingest(atom: AtomType): void;
}

export function serializeBlock(
  payload: BlockPayload,
  allocator: (size: number) => Uint8Array,
): Uint8Array {
  const message = str2bin(taggedStringify(payload));

  const buf = allocator(message.byteLength);
  assert(
    buf.byteLength === message.byteLength,
    `Allocator returned an incorrectly sized buffer!`,
  );
  buf.set(message);

  return buf;
}

export class BlockIngestor implements Ingestor<Block> {
  readonly isSigned = true;

  constructor(private ctx: Context) {}

  serialize(payload: BlockPayload, allocator: (size: number) => Uint8Array): Uint8Array {
    return serializeBlock(payload, allocator);
  }

  deserialize(base: AtomBase, ref?: BlockRef): Block {
    const payload: unknown = taggedParse(bin2str(base.message));
    if (!isBlockPayload(payload)) {
      throw new Error(`Not a block`);
    }

    const block: Block = {
      ...base,
      type: AtomType.Block,
      payload,
      anchor: Hash.equals(payload.anchor, ZERO_HASH)
        ? undefined
        : this.ctx.get(BlockStore).get(payload.anchor),
      aggregates: payload.aggregates.map((x) => ({
        block: this.ctx.get(BlockStore).get(x.block),
        outputCount: x.outputCount,
      })),
      claims: [],
      refs: [],
      anchoringNodes: [],
      aggregatingNodes: [],
      resolvingOutputs: new Map(),
      listeners: ref?.listeners ?? new Set(),
    };

    block.anchor?.anchoringNodes.push(block);

    for (const aggregate of block.aggregates) {
      aggregate.block.aggregatingNodes.push(block);
    }

    for (let i = 0; i < payload.claims.length; i++) {
      const claim: ResolvingClaim = {
        type: OutputResolverType.Claim,
        producer: block,
        outputIdx: payload.claims[i],
        claimer: block,
        claimIdx: i,
        resolved: false,
      };
      this.ctx.get(ClaimIndexService).propagateClaim(claim);

      block.claims.push(claim);
      multimapPut(claim.producer.resolvingOutputs, claim.outputIdx, claim);
    }

    for (let i = 0; i < payload.refs.length; i++) {
      const resolvingRef: ResolvingRef = {
        type: OutputResolverType.Ref,
        producer: block,
        outputIdx: payload.refs[i],
        reffer: block,
        refIdx: i,
        resolved: false,
      };
      this.ctx.get(ClaimIndexService).propagateClaim(resolvingRef);

      block.refs.push(resolvingRef);
      multimapPut(resolvingRef.producer.resolvingOutputs, resolvingRef.outputIdx, resolvingRef);
    }

    if (ref !== undefined) {
      block.anchoringNodes = ref.anchoringNodes;
      for (const anchoring of block.anchoringNodes) {
        assert(anchoring.anchor === ref);
        anchoring.anchor = block;
      }

      block.aggregatingNodes = ref.aggregatingNodes;
      for (const aggregating of block.aggregatingNodes) {
        for (const agg of aggregating.aggregates) {
          if (agg.block === ref) {
            agg.block = block;
          }
        }
      }

      for (const arr of ref.resolvingOutputs.values()) {
        for (const claim of arr) {
          claim.producer = block;
          this.ctx.get(ClaimIndexService).propagateClaim(claim);
          multimapPut(claim.producer.resolvingOutputs, claim.outputIdx, claim);

          if (claim.resolved && claim.type === OutputResolverType.Claim) {
            setTimeout(() => {
              if (claim.claimer.type === AtomType.Block) {
                arrCall(claim.claimer.listeners, { type: BlockActionType.LinkClaim, claim });
              }
              arrCall(claim.producer.listeners, { type: BlockActionType.LinkClaimingNode, claim });
            }, 0);
          }
        }
      }
    }

    return block;
  }

  ingest(block: Block): void {
    for (const link of block.anchoringNodes) {
      arrCall(link.listeners, { type: BlockActionType.LinkAnchor, anchor: block });
    }

    if (block.anchor !== undefined) {
      arrCall(block.anchor.listeners, {
        type: BlockActionType.LinkAnchoringNode,
        anchoringNode: block,
      });
    }

    for (const link of block.aggregatingNodes) {
      arrCall(link.listeners, {
        type: BlockActionType.LinkAggregate,
        aggregate: block,
        index: link.aggregates.findIndex((x) => x.block === block),
      });
    }

    for (let i = 0; i < block.aggregates.length; i++) {
      arrCall(block.aggregates[i].block.listeners, {
        type: BlockActionType.LinkAggregatingNode,
        aggregatingNode: block,
        index: i,
      });
    }
  }
}

export class UnknownIngestor implements Ingestor<never> {
  readonly isSigned = false;

  constructor() {}

  serialize(payload: unknown, allocator: (size: number) => Uint8Array): Uint8Array {
    return todo();
  }

  deserialize(base: AtomBase, ref?: BlockRef) {
    return todo();
  }

  ingest(atom: never): void {}
}
