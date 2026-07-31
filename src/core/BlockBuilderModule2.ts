import { Context } from '../Context.ts';
import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { assert, error, todo } from '../util/functional.ts';
import { BlockStore } from './BlockStore.ts';
import { AnchorChainNode, ClaimIndexService } from './ClaimIndexService.ts';
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
  BlockRef,
  Draft,
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
  protected abstract place(request: PlacementRequest): PlacementResult;
  protected abstract getBlock(hash: Hash): PlacementNode;
  protected abstract resolveClaimIndex(
    anchorChain: AnchorChainNode[],
    outputBlock: Block | typeof DRAFT_SELF,
    outputIndex: bigint,
  ): bigint;
  protected abstract countOutputs(block: Block): bigint;

  build(req: DraftPayload): BuildResult {
    const aggregateBlocks = this.aggregatedBlocks(req);
    const aggregates = aggregateBlocks.map((x) => ({
      block: x.hash,
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

    const mockedAnchorChain: AnchorChainNode[] = [
      { payload: { outputs: req.outputs }, aggregates },
      ...placement.anchorChain,
    ];

    const claims = req.claims.map((x) =>
      this.resolveClaimIndex(mockedAnchorChain, x.producer, x.outputIndex)
    );
    const refs = req.refs.map((x) =>
      this.resolveClaimIndex(mockedAnchorChain, x.producer, x.outputIndex)
    );

    const payload: BlockPayload = {
      anchor: placement.anchorChain[0].hash,
      chain: [{ weight: 0n, throughput: 0n }],
      aggregates,
      claims,
      refs,
      outputs: req.outputs,
      timestampMs: 0,
    };
    return { ok: true, payload };
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
}

export class BlockBuilderService extends BlockBuilderModule {
  constructor(private ctx: Context) {
    super();
  }

  protected override getGenesisBlock() {
    return this.ctx.get(BlockStore).ingest({
      source: AtomSource.Genesis,
      receivedAt: Date.now(),
      raw: this.ctx.config.genesis,
    });
  }

  protected override place(request: PlacementRequest): PlacementResult {
    return this.ctx.get(PlacementService).place(request);
  }

  protected override getBlock(hash: Hash) {
    return this.ctx.get(BlockStore).get(hash);
  }

  protected override resolveClaimIndex(
    anchorChain: AnchorChainNode[],
    outputBlock: Block | typeof DRAFT_SELF,
    outputIndex: bigint,
  ): bigint {
    if (outputBlock === DRAFT_SELF) {
      assert(outputIndex < BigInt(anchorChain[0].payload.outputs.length));
      return outputIndex;
    }
    return this.ctx.get(ClaimIndexService).resolveClaimIndex(anchorChain, outputBlock, outputIndex);
  }

  protected override countOutputs(block: Block): bigint {
    return this.ctx.get(ClaimIndexService).countOutputs(block);
  }
}
