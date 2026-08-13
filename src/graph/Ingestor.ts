import { Context } from '../Context.ts';
import { arrCall } from '../util/array.ts';
import { bin2str, str2bin } from '../util/buffer.ts';
import { assert, todo } from '../util/functional.ts';
import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { taggedParse, taggedStringify } from '../util/json.ts';
import { mapPop, multimapPut } from '../util/map.ts';
import { BlockStore } from './BlockStore.ts';
import { ClaimIndex } from './ClaimIndex.ts';
import {
  Atom,
  AtomBase,
  AtomType,
  Block,
  BLOCK_REF_TYPE,
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

  private newlyResolved = new Map<Block, (ResolvingClaim | ResolvingRef)[]>();

  private claimResolutionListeners = new Set<(claim: ResolvingClaim) => void>();

  constructor(private ctx: Context) {}

  onClaimResolution(cb: (claim: ResolvingClaim) => void, signal: AbortSignal) {
    if (signal.aborted) return;
    this.claimResolutionListeners.add(cb);
    signal.addEventListener('abort', () => assert(this.claimResolutionListeners.delete(cb)));
  }

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
      const resolvingClaim: ResolvingClaim = {
        type: OutputResolverType.Claim,
        producer: block,
        outputIdx: payload.claims[i],
        claimer: block,
        claimIdx: i,
        resolved: false,
      };
      block.claims.push(resolvingClaim);
      this.propagateResolving(resolvingClaim, block);
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
      block.refs.push(resolvingRef);
      this.propagateResolving(resolvingRef, block);
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
          this.propagateResolving(claim, block);
        }
      }
    }

    return block;
  }

  ingest(block: Block): void {
    for (const link of block.anchoringNodes) {
      arrCall(link.listeners, this.ctx.logger('ingestor'), {
        type: BlockActionType.LinkAnchor,
        anchor: block,
      });
    }

    if (block.anchor !== undefined) {
      arrCall(block.anchor.listeners, this.ctx.logger('ingestor'), {
        type: BlockActionType.LinkAnchoringNode,
        anchoringNode: block,
      });
    }

    for (const link of block.aggregatingNodes) {
      arrCall(link.listeners, this.ctx.logger('ingestor'), {
        type: BlockActionType.LinkAggregate,
        aggregate: block,
        index: link.aggregates.findIndex((x) => x.block === block),
      });
    }

    for (let i = 0; i < block.aggregates.length; i++) {
      arrCall(block.aggregates[i].block.listeners, this.ctx.logger('ingestor'), {
        type: BlockActionType.LinkAggregatingNode,
        aggregatingNode: block,
        index: i,
      });
    }

    for (const prop of mapPop(this.newlyResolved, block) ?? []) {
      assert(prop.resolved);

      if (prop.type === OutputResolverType.Claim) {
        if (prop.claimer.type === AtomType.Block) {
          arrCall(prop.claimer.listeners, this.ctx.logger('ingestor'), {
            type: BlockActionType.LinkClaim,
            claim: prop,
          });
        }
        arrCall(prop.producer.listeners, this.ctx.logger('ingestor'), {
          type: BlockActionType.LinkClaimingNode,
          claim: prop,
        });

        arrCall(this.claimResolutionListeners, this.ctx.logger('ingestor'), prop);
      }
    }
    assert(this.newlyResolved.size === 0);
  }

  private propagateResolving(propagation: ResolvingClaim | ResolvingRef, currentBlock: Block) {
    this.ctx.get(ClaimIndex).propagateClaim(propagation);
    assert(propagation.resolved || propagation.producer.type === BLOCK_REF_TYPE);
    multimapPut(propagation.producer.resolvingOutputs, propagation.outputIdx, propagation);

    if (propagation.resolved) {
      multimapPut(this.newlyResolved, currentBlock, propagation);
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
