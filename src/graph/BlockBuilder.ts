import { Context } from '../Context.ts';
import { Hash } from '../util/Hash.ts';
import { assert, assertEquals, error } from '../util/functional.ts';
import { BlockStore } from './BlockStore.ts';
import { AnchorChainNode, ClaimIndex } from './ClaimIndex.ts';
import { AggregatorNodeBase } from '../logic/Forest.ts';
import { Placement, PlacementNode, PlacementRequest, PlacementResult } from './Placement.ts';
import {
  AtomSource,
  AtomType,
  Block,
  BlockPayload,
  DRAFT_SELF,
  DraftPayload,
  Output,
  OutputResolverType,
} from './types.ts';
import { AGGREGATION_CONTRACT } from '../contract/static/Aggregation.ts';
import { Genesis } from './Genesis.ts';

export type BuildResult =
  | { ok: true; payload: BlockPayload }
  | { ok: false; pendingAggregation: PlacementNode[] };

export abstract class BlockBuilderBase {
  protected abstract getGenesisBlock(): PlacementNode;
  protected abstract nowMs(): number;
  protected abstract place(request: PlacementRequest): PlacementResult;
  protected abstract getBlock(hash: Hash): PlacementNode;
  protected abstract resolveClaimIndex(
    anchorChain: AnchorChainNode[],
    outputBlock: AggregatorNodeBase & AnchorChainNode,
    outputIndex: number,
  ): bigint;
  protected abstract countOutputs(block: Block): bigint;

  build(req: DraftPayload): BuildResult {
    this.checkBalanced(req);

    const aggregateBlocks = this.aggregatedBlocks(req);
    const aggregates = aggregateBlocks.map((x) => ({
      block: x,
      outputCount: this.countOutputs(x),
    }));

    const placement = this.place({
      genesis: this.getGenesisBlock(),
      includes: [...req.claims, ...req.refs].map((x) => x.producer).filter((x) => x !== DRAFT_SELF),
      aggregates: aggregateBlocks,
      excludes: this.rivalClaimants(req),
    });
    if (!placement.ok) {
      return { ok: false, pendingAggregation: placement.tips };
    }

    const mockBlock = { payload: { outputs: req.outputs }, aggregates, aggregatingNodes: [] };
    const mockedAnchorChain: AnchorChainNode[] = [mockBlock, ...placement.anchorChain];

    const claims = req.claims.map((x) =>
      this.resolveClaimIndex(
        mockedAnchorChain,
        x.producer === DRAFT_SELF ? mockBlock : x.producer,
        x.outputIndex,
      )
    );
    const refs = req.refs.map((x) =>
      this.resolveClaimIndex(
        mockedAnchorChain,
        x.producer === DRAFT_SELF ? mockBlock : x.producer,
        x.outputIndex,
      )
    );

    const anchor = placement.anchorChain[0];
    const payload: BlockPayload = {
      anchor: anchor.hash,
      chain: [{ weight: 0n, throughput: 0n }],
      aggregates: aggregates.map((x) => ({ block: x.block.hash, outputCount: x.outputCount })),
      claims,
      refs,
      outputs: req.outputs,
      timestampMs: this.computeTimestamp(req.minTimestampMs, anchor, aggregateBlocks),
    };
    return { ok: true, payload };
  }

  private claimedOutput(req: DraftPayload, claim: DraftPayload['claims'][number]): Output {
    const outputs = claim.producer === DRAFT_SELF ? req.outputs : claim.producer.payload.outputs;
    const output = outputs[claim.outputIndex];
    if (output === undefined) {
      const producer = claim.producer === DRAFT_SELF ? 'self' : claim.producer.hash.toHex();
      return error(`build: claim on ${producer} output ${claim.outputIndex} is out of range`);
    }
    return output;
  }

  private checkBalanced(req: DraftPayload) {
    let claimedSum = 0n;
    for (const claim of req.claims) {
      claimedSum += this.claimedOutput(req, claim).amount;
    }

    let outputSum = 0n;
    for (const output of req.outputs) {
      outputSum += output.amount;
    }

    assertEquals(claimedSum, outputSum);
  }

  private aggregatedBlocks(req: DraftPayload): (PlacementNode & { type: AtomType.Block })[] {
    const found: (PlacementNode & { type: AtomType.Block })[] = [];
    for (const claim of req.claims) {
      if (claim.producer === DRAFT_SELF) continue;
      if (Hash.equals(this.claimedOutput(req, claim).contract, AGGREGATION_CONTRACT)) {
        found.push(claim.producer);
      }
    }
    return found;
  }

  private rivalClaimants(req: DraftPayload): PlacementNode[] {
    const rivals = new Set<PlacementNode>();
    for (const claim of req.claims) {
      if (claim.producer === DRAFT_SELF) continue;
      for (const rival of claim.producer.resolvingOutputs.get(BigInt(claim.outputIndex)) ?? []) {
        if (rival.type !== OutputResolverType.Claim) continue;
        if (rival.claimer.type !== AtomType.Block) continue;
        rivals.add(rival.claimer);
      }
    }
    return [...rivals.values()];
  }

  private computeTimestamp(
    minTimestampMs: number,
    anchor: Block,
    aggregateBlocks: Block[],
  ): number {
    return aggregateBlocks.reduce(
      (acc, cur) => Math.max(acc, cur.payload.timestampMs),
      Math.max(this.nowMs(), minTimestampMs, anchor.payload.timestampMs),
    );
  }
}

export class BlockBuilder extends BlockBuilderBase {
  constructor(private ctx: Context) {
    super();
  }

  protected override getGenesisBlock() {
    return this.ctx.get(Genesis).getGenesis();
  }

  protected override nowMs(): number {
    return this.ctx.config.timeProvider.nowMs();
  }

  protected override place(request: PlacementRequest): PlacementResult {
    return this.ctx.get(Placement).place(request);
  }

  protected override getBlock(hash: Hash) {
    return this.ctx.get(BlockStore).get(hash);
  }

  protected override resolveClaimIndex(
    anchorChain: AnchorChainNode[],
    outputBlock: AggregatorNodeBase & AnchorChainNode,
    outputIndex: number,
  ): bigint {
    assert(outputIndex < outputBlock.payload.outputs.length);
    return this.ctx.get(ClaimIndex)
      .resolveClaimIndex(anchorChain, outputBlock, BigInt(outputIndex));
  }

  protected override countOutputs(block: Block): bigint {
    return this.ctx.get(ClaimIndex).countOutputs(block);
  }
}
