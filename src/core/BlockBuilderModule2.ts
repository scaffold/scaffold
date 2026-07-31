import { Context } from '../Context.ts';
import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { assert, assertEquals, error } from '../util/functional.ts';
import { BlockStore } from './BlockStore.ts';
import { AnchorChainNode, ClaimIndexService } from './ClaimIndexService.ts';
import { AggregatorNodeBase } from './ForestService.ts';
import {
  PlacementNode,
  PlacementRequest,
  PlacementResult,
  PlacementService,
} from './PlacementService2.ts';
import {
  AGGREGATION_CONTRACT,
  AtomSource,
  AtomType,
  Block,
  BlockPayload,
  DRAFT_SELF,
  DraftPayload,
  Output,
  OutputResolverType,
} from './types.ts';

export type BuildResult =
  | { ok: true; payload: BlockPayload }
  | { ok: false; pendingAggregation: PlacementNode[] };

export abstract class BlockBuilderModule {
  protected abstract getGenesisBlock(): PlacementNode;
  protected abstract nowMs(): number;
  protected abstract place(request: PlacementRequest): PlacementResult;
  protected abstract getBlock(hash: Hash): PlacementNode;
  protected abstract resolveClaimIndex(
    anchorChain: AnchorChainNode[],
    outputBlock: AggregatorNodeBase & AnchorChainNode,
    outputIndex: bigint,
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
      timestampMs: this.computeTimestamp(anchor, aggregateBlocks),
    };
    return { ok: true, payload };
  }

  private checkBalanced(req: DraftPayload) {
    let claimedSum = 0n;
    for (const claim of req.claims) {
      const outputs = claim.producer === DRAFT_SELF ? req.outputs : claim.producer.payload.outputs;
      claimedSum += outputs[Number(claim.outputIndex)].amount;
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
      const output = claim.producer.payload.outputs[Number(claim.outputIndex)];
      if (output === undefined) {
        return error(
          `build: claim on ${claim.producer.hash.toHex()} output ${claim.outputIndex} is out of range`,
        );
      }
      if (Hash.equals(output.contract, AGGREGATION_CONTRACT)) {
        found.push(claim.producer);
      }
    }
    return found;
  }

  private rivalClaimants(req: DraftPayload): PlacementNode[] {
    const rivals = new Set<PlacementNode>();
    for (const claim of req.claims) {
      if (claim.producer === DRAFT_SELF) continue;
      for (const rival of claim.producer.resolvingOutputs.get(claim.outputIndex) ?? []) {
        if (rival.type !== OutputResolverType.Claim) continue;
        if (rival.claimer.type !== AtomType.Block) continue;
        rivals.add(rival.claimer);
      }
    }
    return [...rivals.values()];
  }

  private computeTimestamp(anchor: Block, aggregateBlocks: Block[]): number {
    return aggregateBlocks.reduce(
      (acc, cur) => Math.max(acc, cur.payload.timestampMs),
      Math.max(anchor.payload.timestampMs, this.nowMs()),
    );
  }
}

export class BlockBuilderService extends BlockBuilderModule {
  constructor(private ctx: Context) {
    super();
  }

  protected override getGenesisBlock() {
    return this.ctx.get(BlockStore).ingest({
      source: AtomSource.Genesis,
      receivedAt: this.ctx.config.timeProvider.nowMs(),
      raw: this.ctx.config.genesis,
    });
  }

  protected override nowMs(): number {
    return this.ctx.config.timeProvider.nowMs();
  }

  protected override place(request: PlacementRequest): PlacementResult {
    return this.ctx.get(PlacementService).place(request);
  }

  protected override getBlock(hash: Hash) {
    return this.ctx.get(BlockStore).get(hash);
  }

  protected override resolveClaimIndex(
    anchorChain: AnchorChainNode[],
    outputBlock: AggregatorNodeBase & AnchorChainNode,
    outputIndex: bigint,
  ): bigint {
    assert(outputIndex < BigInt(outputBlock.payload.outputs.length));
    return this.ctx.get(ClaimIndexService).resolveClaimIndex(anchorChain, outputBlock, outputIndex);
  }

  protected override countOutputs(block: Block): bigint {
    return this.ctx.get(ClaimIndexService).countOutputs(block);
  }
}
