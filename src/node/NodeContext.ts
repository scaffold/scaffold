import {
  AGGREGATION_CONTRACT,
  Block,
  BlockStore,
  COLLATERAL_CONTRACT,
  encodeAggregationData,
  getAggregationData,
  INSURANCE_CONTRACT,
} from '../core/Block.ts';
import { type BlockDraft, DraftStore } from '../core/BlockDraft.ts';
import { BlockBlueprint, BlockSpec, type ClaimEntry, Output } from '../core/BlockCreationModule.ts';
import {
  type OutputSpaceBlock,
  OutputSpaceModule,
  type OutputSpaceProvider,
} from '../core/OutputSpace.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { ContractGenerator } from '../core/ContractGenerator.ts';
import { aggregationContract } from '../core/AggregationContract.ts';
import { collateralContract } from '../core/CollateralContract.ts';
import { insuranceContract } from '../core/InsuranceContract.ts';
import type { Contract } from '../core/Contract.ts';
import { composeBlockPacket, composeUnsignedBlockPacket } from '../core/Packet.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { Coordinator } from '../core/Coordinator.ts';
import {
  BlockCreator,
  FetchResult,
  ReactiveLayer,
  Strategy,
  VerifierKey,
} from './ReactiveLayer.ts';
import { BlockCreationService } from '../core/BlockCreationService.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { SamplingService } from '../core/SamplingService.ts';
import { GossipService } from '../core/GossipService.ts';
import { TrustService } from '../core/TrustService.ts';
import { OutputClaimService } from '../core/OutputClaimService.ts';
import { Hash } from '../util/Hash.ts';
import { BlockRecordSet } from '../reactive/BlockRecordSet.ts';
import { UtxoIndex } from './UtxoIndex.ts';
import { DraftStrategy } from './strategies/DraftStrategy.ts';

export interface NodeConfig {
  /** Genesis block (pre-built). */
  genesis: Block;
  /** Strategies to register with the reactive layer */
  strategies?: Strategy[];
  /** Callback when a notifyFetch action is dispatched */
  onNotifyFetch?: (verifier: VerifierKey, result: FetchResult | null) => void;
  /** Filter: should generation run for this contract hash? Default: all enabled. */
  enableGeneration?: (contractHash: Hash) => boolean;
  /** Filter: should verification run for this contract hash? Default: all enabled. */
  enableVerification?: (contractHash: Hash) => boolean;
}

/**
 * NodeContext wires together the protocol layer and the node layer.
 * Created by the Scaffold constructor.
 */
export class NodeContext {
  readonly store: BlockStore;
  readonly draftStore: DraftStore;
  readonly protocolContext: ProtocolContext;
  readonly coordinator: Coordinator;
  readonly reactiveLayer: ReactiveLayer;
  readonly draftManager: DraftManager;
  readonly utxoIndex: UtxoIndex;

  // Protocol services (convenience accessors)
  readonly consensus: ConsensusService;
  readonly sampling: SamplingService;
  readonly gossip: GossipService;
  readonly trust: TrustService;
  readonly blockCreation: BlockCreationService;
  readonly outputClaims: OutputClaimService;

  /** Reactive block record set - notifies listeners on block add/update. */
  readonly blocks: BlockRecordSet;

  private readonly _genesisHash: Hash;

  constructor(config: NodeConfig) {
    // 1. Create ProtocolContext (DI container)
    this.protocolContext = new ProtocolContext();

    // 2. Get BlockStore from context (lazily created by DI)
    this.store = this.protocolContext.get(BlockStore);

    // 2b. Create DraftStore and wire to ConsensusService
    this.draftStore = new DraftStore();

    // 3. Get all services from ProtocolContext
    this.consensus = this.protocolContext.get(ConsensusService);
    this.consensus.setDraftStore(this.draftStore);
    this.sampling = this.protocolContext.get(SamplingService);
    this.gossip = this.protocolContext.get(GossipService);
    this.trust = this.protocolContext.get(TrustService);
    this.blockCreation = this.protocolContext.get(BlockCreationService);
    this.outputClaims = this.protocolContext.get(OutputClaimService);

    // 4. Create Coordinator
    this.coordinator = this.protocolContext.get(Coordinator);

    // 5. Create a BlockCreator that uses BlockCreationService
    const blockCreationService = this.blockCreation;
    const blockCreator: BlockCreator = {
      createBlock: (spec, privateKey) => {
        let blueprint: BlockBlueprint;
        try {
          blueprint = blockCreationService.buildBlock(spec);
        } catch (e) {
          console.debug('createBlock failed:', (e as Error).message);
          return null;
        }
        if (privateKey) {
          return composeBlockPacket(blueprint, privateKey).block;
        }
        return composeUnsignedBlockPacket(blueprint).block;
      },
    };

    // 5b. Create UtxoIndex
    this.utxoIndex = new UtxoIndex(this.store);

    // 5c. Create ContractGenerator with built-in contracts
    const contracts = new Map<string, Contract>();
    contracts.set(AGGREGATION_CONTRACT.toHex(), aggregationContract);
    contracts.set(COLLATERAL_CONTRACT.toHex(), collateralContract);
    contracts.set(INSURANCE_CONTRACT.toHex(), insuranceContract);

    const contractGenerator = new ContractGenerator({
      lookupContract: (hash) => contracts.get(hash.toHex()),
      store: this.store,
      utxoIndex: this.utxoIndex,
      outputClaims: this.outputClaims,
      draftStore: this.draftStore,
    });

    // 5d. Create DraftManager with ContractGenerator
    this.draftManager = new DraftManager(this.draftStore, this.consensus, contractGenerator);
    this.consensus.onCanonicalityChange((hash, canonical) => {
      this.draftManager.onCanonicalityChange(hash, canonical);
    });

    // 5e. Wire UtxoIndex to canonicality changes
    this.consensus.onCanonicalityChange((hash, canonical) => {
      const block = this.store.get(hash);
      if (!block) return;
      if (canonical) {
        this.utxoIndex.blockBecameCanonical(block);
      } else {
        this.utxoIndex.blockBecameNonCanonical(block);
      }
    });

    // 6. Create BlockRecordSet and wire module listeners
    this.blocks = new BlockRecordSet({ debounceMs: 0 });

    this.consensus.onCanonicalityChange((hash, _canonical) => {
      const block = this.store.get(hash);
      if (block) this.blocks.notifyChanged(block);
    });
    this.sampling.onWeightChange((hash) => {
      const block = this.store.get(hash);
      if (block) this.blocks.notifyChanged(block);
    });
    this.trust.onCollateralChange((targetHash) => {
      const block = this.store.get(targetHash);
      if (block) this.blocks.notifyChanged(block);
    });

    // 7. Create built-in DraftStrategy and combine with user strategies.
    //    Default enableGeneration to only registered contracts so that
    //    outputs for unregistered contracts don't waste inFlight slots.
    const enableGeneration = config.enableGeneration ??
      ((hash: Hash) => contracts.has(hash.toHex()));
    const draftStrategy = new DraftStrategy(
      { enableGeneration },
      contractGenerator,
    );
    const strategies: Strategy[] = [
      draftStrategy,
      ...(config.strategies ?? []),
    ];

    // 8. Create ReactiveLayer with strategies
    const blocks = this.blocks;
    this.reactiveLayer = new ReactiveLayer({
      coordinator: this.coordinator,
      store: this.store,
      consensus: this.consensus,
      sampling: this.sampling,
      strategies,
      blockCreator,
      draftManager: this.draftManager,
      onNotifyFetch: config.onNotifyFetch,
      onBlockProcessed: (block: Block) => {
        blocks.add(block);
      },
    });

    // 9. Wire draft solidification: when a draft becomes ready, build and process it.
    //    Release inFlight slots BEFORE solidification so that when the new
    //    block is processed, DraftStrategy has room to create follow-on drafts.
    this.draftStore.onTransition((draft) => {
      if (draft.status !== 'ready') return;
      for (const rc of draft.resolvedClaims) {
        draftStrategy.complete(rc.block, rc.outputIndex);
      }
      this._solidifyDraft(draft, blockCreator);
    });

    // 10. Process genesis block through coordinator directly
    //    (not through reactive layer, since strategies should not fire on genesis)
    const genesis = config.genesis;
    this.coordinator.blockReceived(genesis, null);
    this.blocks.add(genesis);
    this._genesisHash = genesis.hash;

    // Seed the UTXO index with genesis outputs. The first flushChanges()
    // initializes the canonical snapshot without firing listeners, so
    // genesis outputs must be indexed explicitly.
    this.utxoIndex.blockBecameCanonical(genesis);
  }

  /** Process a block through the reactive layer */
  processBlock(block: Block, fromPeer?: string | null): void {
    this.reactiveLayer.processBlock(block, fromPeer ?? null);
  }

  /**
   * Solidify a ready draft into a real block and process it.
   *
   * Determines anchor and aggregates from the draft's includeConstraints,
   * uses OutputSpaceModule to compute claim indices and the composed
   * aggregation claim mask.
   */
  private _solidifyDraft(draft: BlockDraft, blockCreator: BlockCreator): void {
    const includes = draft.includeConstraints;
    if (includes.length === 0) {
      this.draftManager.cancelDraft(draft.draftId);
      return;
    }

    // Find the deepest common ancestor of all include-constrained blocks.
    const anchor = this._findCommonAncestor(includes);
    if (!anchor) {
      this.draftManager.cancelDraft(draft.draftId);
      return;
    }

    const anchorKey = anchor.toPrimitive();
    const aggregates = includes.filter((h) => h.toPrimitive() !== anchorKey);

    // Build per-aggregate output counts from caches (or leaf defaults)
    const aggregateOutputCounts: number[] = [];
    for (const aggHash of aggregates) {
      const aggBlock = this.store.get(aggHash);
      if (!aggBlock) {
        aggregateOutputCounts.push(0);
        continue;
      }
      const aggData = getAggregationData(aggBlock);
      const sc = aggBlock.claims.filter((c) => c < aggBlock.outputs.length).length;
      aggregateOutputCounts.push(aggData?.newOutputCount ?? (aggBlock.outputs.length - sc));
    }

    // Create a virtual OutputSpaceBlock for the block being solidified.
    // This lets OutputSpaceModule compute claim indices and claim masks
    // even though the block doesn't exist in the store yet.
    const selfClaimCount = 0; // Solidified blocks don't self-claim
    const virtualHash = draft.draftId;
    const virtualBlock: OutputSpaceBlock = {
      hash: virtualHash,
      anchor,
      aggregates,
      outputs: draft.outputs.map((o) => ({ value: o.value })),
      claims: [], // Will be filled after computation
      aggregateOutputCounts,
      newOutputCount: draft.outputs.length - selfClaimCount +
        aggregateOutputCounts.reduce((a, b) => a + b, 0),
    };

    // Provider that includes the virtual block + real store blocks
    const store = this.store;
    const virtualProvider: OutputSpaceProvider = {
      getBlock(hash: Hash): OutputSpaceBlock | undefined {
        if (Hash.equals(hash, virtualHash)) return virtualBlock;
        const block = store.get(hash);
        if (!block) return undefined;
        const aggData = getAggregationData(block);
        const sc = block.claims.filter((c) => c < block.outputs.length).length;
        return {
          hash: block.hash,
          anchor: block.anchor,
          aggregates: block.aggregates,
          outputs: block.outputs.map((o) => ({ value: o.value })),
          claims: [...block.claims].sort((a, b) => a - b),
          aggregateOutputCounts: aggData?.aggregateOutputCounts ?? [],
          newOutputCount: aggData?.newOutputCount ?? (block.outputs.length - sc),
        };
      },
    };

    const outputSpace = new OutputSpaceModule(virtualProvider);

    // Compute claim indices using OutputSpaceModule
    const claims: ClaimEntry[] = [];
    for (const rc of draft.resolvedClaims) {
      const idx = outputSpace.computeClaimIndex(virtualHash, {
        block: rc.block,
        outputIndex: rc.outputIndex,
      });
      if (idx !== undefined) {
        claims.push({ index: idx, value: rc.value });
      }
    }

    // Compute the composed claim mask for the aggregation data output
    const composedClaimMask = outputSpace.subtreeClaimMask(virtualHash) ?? [];

    // Update the aggregation data output with the composed claim mask
    const outputs = this._patchAggregationOutput(
      draft.outputs,
      composedClaimMask,
      aggregateOutputCounts,
      virtualBlock.newOutputCount,
    );

    const spec: BlockSpec = {
      anchor,
      outputs,
      claims,
      declaredWeight: draft.declaredWeight,
      aggregates,
      refs: draft.refs,
    };

    const block = blockCreator.createBlock(spec, null);
    if (block) {
      this.reactiveLayer.processBlock(block, null);
    }

    this.draftManager.cancelDraft(draft.draftId);
  }

  /** Find the deepest common ancestor of a set of block hashes. */
  private _findCommonAncestor(includes: Hash[]): Hash | undefined {
    const depthMaps: Map<string, number>[] = [];
    for (const incHash of includes) {
      const map = new Map<string, number>();
      let cur = incHash;
      let depth = 0;
      while (this.store.has(cur)) {
        map.set(cur.toPrimitive(), depth);
        const block = this.store.get(cur)!;
        cur = block.anchor;
        depth++;
      }
      depthMaps.push(map);
    }

    let anchor: Hash | undefined;
    let bestDepth = Infinity;
    for (const [key, depth] of depthMaps[0]) {
      if (depthMaps.every((m) => m.has(key))) {
        const maxDepth = Math.max(...depthMaps.map((m) => m.get(key)!));
        if (maxDepth < bestDepth) {
          bestDepth = maxDepth;
          anchor = Hash.fromPrimitive(key);
        }
      }
    }

    return anchor;
  }

  /**
   * Patch the aggregation data output with the composed claim mask.
   * If the draft has an aggregation data output (from the contract),
   * update its claimMask. Otherwise return outputs unchanged.
   */
  private _patchAggregationOutput(
    outputs: Output[],
    claimMask: number[],
    aggregateOutputCounts: number[],
    newOutputCount: number,
  ): Output[] {
    return outputs.map((output) => {
      if (!Hash.equals(output.verifier.contract, AGGREGATION_CONTRACT)) return output;
      if (output.data.length === 0) return output; // marker, not data

      // Decode, patch claimMask, re-encode
      const aggData = getAggregationData({
        outputs: [output],
      } as Block);
      if (!aggData) return output;

      return {
        ...output,
        data: encodeAggregationData({
          ...aggData,
          claimMask,
          aggregateOutputCounts,
          newOutputCount,
        }),
      };
    });
  }

  /** Get the genesis block hash (first block in store) */
  get genesisHash(): Hash {
    return this._genesisHash;
  }
}
