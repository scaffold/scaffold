import {
  AGGREGATION_CONTRACT,
  Block,
  BlockStore,
  COLLATERAL_CONTRACT,
  INSURANCE_CONTRACT,
  RECORD_CONTRACT,
  SIGNATURE_CONTRACT,
} from '../core/Block.ts';
import { type BlockDraft, DraftStore } from '../core/BlockDraft.ts';
import { BlockBlueprint, BlockSpec, type ClaimEntry, Output } from '../core/BlockCreationModule.ts';
import { makeSignatureOutput, signatureContract } from '../contracts/SignatureContract.ts';
import {
  type OutputSpaceBlock,
  OutputSpaceModule,
  type OutputSpaceProvider,
} from '../core/OutputSpace.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { ContractGenerator } from '../core/ContractGenerator.ts';
import {
  aggregationContract,
  encodeAggregationData,
  getAggregationData,
} from '../contracts/AggregationContract.ts';
import { collateralContract } from '../contracts/CollateralContract.ts';
import { insuranceContract } from '../contracts/InsuranceContract.ts';
import { recordContract } from '../contracts/RecordContract.ts';
import type { Contract } from '../contracts/Contract.ts';
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
import { GossipService } from './GossipService.ts';
import { RoutingService } from './RoutingService.ts';
import { PushAction } from './RoutingModule.ts';
import { TrustService } from '../core/TrustService.ts';
import { OutputClaimService } from '../core/OutputClaimService.ts';
import { ExecutionService } from '../core/ExecutionService.ts';
import { Hash } from '../util/Hash.ts';
import { BlockRecordSet } from '../reactive/BlockRecordSet.ts';
import { UtxoIndex, verifierKey } from './UtxoIndex.ts';
import { DraftStrategy } from './strategies/DraftStrategy.ts';
import { EventLog } from '../core/EventLog.ts';

export interface NodeConfig {
  /** Genesis block (pre-built). */
  genesis: Block;
  /** Private key for signing blocks. If provided, solidified drafts will be signed. */
  privateKey?: Uint8Array;
  /** Public key (compressed, 33 bytes). Derived from privateKey. Used for auto-balance. */
  publicKey?: Uint8Array;
  /** Strategies to register with the reactive layer */
  strategies?: Strategy[];
  /** Callback when a notifyFetch action is dispatched */
  onNotifyFetch?: (verifier: VerifierKey, result: FetchResult | null) => void;
  /** Check if a fetch subscription exists for a verifier key */
  hasFetchSubscription?: (verifierKey: string) => boolean;
  /** Filter: should generation run for this contract hash? Default: all enabled. */
  enableGeneration?: (contractHash: Hash) => boolean;
  /** Filter: should verification run for this contract hash? Default: all enabled. */
  enableVerification?: (contractHash: Hash) => boolean;
  /** Callback when gossip produces push actions for a block */
  onPushActions?: (actions: PushAction[], block: Block) => void;
  /** Event log for structured observability. */
  eventLog?: EventLog;
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
  readonly routing: RoutingService;
  readonly trust: TrustService;
  readonly blockCreation: BlockCreationService;
  readonly outputClaims: OutputClaimService;
  readonly execution: ExecutionService;

  /** Reactive block record set - notifies listeners on block add/update. */
  readonly blocks: BlockRecordSet;

  private readonly _genesisHash: Hash;
  private readonly _privateKey: Uint8Array | null;
  private readonly _publicKey: Uint8Array | null;
  private readonly _contracts: Map<string, Contract>;
  private readonly _blockCreator: BlockCreator;

  /** Cache of resolved claims relevant to active fetch subscriptions. */
  private readonly _claimFetchCache = new Map<
    string,
    { claimant: Hash; target: { block: Hash; outputIndex: number } }
  >();

  constructor(config: NodeConfig) {
    // 0. Store key material
    this._privateKey = config.privateKey ?? null;
    this._publicKey = config.publicKey ?? null;

    // 1. Create ProtocolContext (DI container)
    this.protocolContext = new ProtocolContext(config.eventLog);

    // 2. Get BlockStore from context (lazily created by DI)
    this.store = this.protocolContext.get(BlockStore);

    // 2b. Create DraftStore and wire to ConsensusService
    this.draftStore = new DraftStore();

    // 3. Get all services from ProtocolContext
    this.consensus = this.protocolContext.get(ConsensusService);
    this.consensus.setDraftStore(this.draftStore);
    this.sampling = this.protocolContext.get(SamplingService);
    this.trust = this.protocolContext.get(TrustService);

    // 3b. Create UtxoIndex early (needed by GossipService for backfill queries)
    this.utxoIndex = new UtxoIndex(this.store);

    this.gossip = new GossipService(this.protocolContext, this.utxoIndex);
    this.routing = new RoutingService(this.protocolContext, this.gossip);
    this.blockCreation = this.protocolContext.get(BlockCreationService);
    this.outputClaims = this.protocolContext.get(OutputClaimService);
    this.execution = this.protocolContext.get(ExecutionService);

    // 4. Create Coordinator
    this.coordinator = this.protocolContext.get(Coordinator);

    // 5. Create a BlockCreator that uses BlockCreationService.
    //    Auto-balances throughput if a publicKey is configured.
    const blockCreationService = this.blockCreation;
    const publicKey = this._publicKey;
    const utxoIndex = this.utxoIndex;
    this._blockCreator = {
      createBlock: (spec, privateKey) => {
        const balanced = publicKey ? autoBalance(spec, utxoIndex, publicKey) : spec;
        let blueprint: BlockBlueprint;
        try {
          blueprint = blockCreationService.buildBlock(balanced);
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

    // 5c. Create ContractGenerator with built-in contracts
    this._contracts = new Map<string, Contract>();
    this._registerBuiltinContract(AGGREGATION_CONTRACT, aggregationContract);
    this._registerBuiltinContract(COLLATERAL_CONTRACT, collateralContract);
    this._registerBuiltinContract(INSURANCE_CONTRACT, insuranceContract);
    this._registerBuiltinContract(RECORD_CONTRACT, recordContract);
    this._registerBuiltinContract(SIGNATURE_CONTRACT, signatureContract);

    const contracts = this._contracts;
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

    // 5f. Wire claim resolutions to gossip claim history and fetch notifications.
    //     When a claim resolves, add it to claim history and route the
    //     claiming block toward the claimed output. Also check if the claimed
    //     output has an active fetch subscription -- if so, cache the resolution
    //     for canonical state tracking.
    this.outputClaims.onResolution((claimant, target) => {
      const source = this.store.get(target.block);
      if (!source) return;
      const output = source.outputs[target.outputIndex];
      if (!output) return;
      const vk = verifierKey(output.verifier.contract, output.verifier.params);
      this.gossip.notifyClaimResolved(claimant, vk, output.value, target.block);

      // Check if a fetch subscription exists for this verifier
      if (config.hasFetchSubscription?.(vk)) {
        this._claimFetchCache.set(vk, {
          claimant,
          target: { block: target.block, outputIndex: target.outputIndex },
        });
        // If already canonical, notify immediately
        if (this.consensus.isCanonical(claimant) && config.onNotifyFetch) {
          this._notifyFetchFromClaim(vk, claimant, config.onNotifyFetch);
        }
      }
    });

    // 5g. Wire canonicality changes to fetch notifications for claim-based results.
    this.consensus.onCanonicalityChange((hash, canonical) => {
      for (const [vk, entry] of this._claimFetchCache) {
        if (!Hash.equals(entry.claimant, hash)) continue;
        if (config.onNotifyFetch) {
          if (canonical) {
            this._notifyFetchFromClaim(vk, entry.claimant, config.onNotifyFetch);
          } else {
            config.onNotifyFetch(vk, null);
          }
        }
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
      blockCreator: this._blockCreator,
      routing: this.routing,
      draftManager: this.draftManager,
      logger: this.protocolContext.logger('reactive'),
      onNotifyFetch: config.onNotifyFetch,
      onPushActions: config.onPushActions,
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
      this._solidifyDraft(draft);
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

  /** Register a contract at runtime for generation and verification. */
  registerContract(hash: Hash, contract: Contract): void {
    this._contracts.set(hash.toHex(), contract);
    this.execution.registerContract(hash, contract);
  }

  /** Internal: register a contract on both the generator registry and ExecutionService. */
  private _registerBuiltinContract(hash: Hash, contract: Contract): void {
    this._contracts.set(hash.toHex(), contract);
    this.execution.registerContract(hash, contract);
  }

  /** Create a block from a spec, with auto-balance and optional signing. */
  createBlock(spec: BlockSpec, privateKey: Uint8Array | null): Block | null {
    return this._blockCreator.createBlock(spec, privateKey);
  }

  /**
   * Solidify a ready draft into a real block and process it.
   *
   * Determines anchor and aggregates from the draft's includeConstraints,
   * uses OutputSpaceModule to compute claim indices and the composed
   * aggregation claim mask.
   */
  private _solidifyDraft(draft: BlockDraft): void {
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

    const block = this._blockCreator.createBlock(spec, this._privateKey);
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

  /** Notify fetch subscribers when a claim resolves on a canonical block. */
  private _notifyFetchFromClaim(
    vk: string,
    claimant: Hash,
    onNotifyFetch: (verifier: VerifierKey, result: FetchResult | null) => void,
  ): void {
    const claimantBlock = this.store.get(claimant);
    if (!claimantBlock) return;

    // Find the first self-claimed RECORD_CONTRACT output
    const selfClaimSet = new Set(
      claimantBlock.claims.filter((c) => c < claimantBlock.outputs.length),
    );
    let resultData: Uint8Array = new Uint8Array(0);
    for (let i = 0; i < claimantBlock.outputs.length; i++) {
      if (!selfClaimSet.has(i)) continue;
      const output = claimantBlock.outputs[i];
      if (Hash.equals(output.verifier.contract, RECORD_CONTRACT)) {
        resultData = output.data;
        break;
      }
    }

    onNotifyFetch(vk, { block: claimantBlock, data: resultData });
  }

  /** Get the genesis block hash (first block in store) */
  get genesisHash(): Hash {
    return this._genesisHash;
  }
}

// -- Module-level helpers -------------------------------------------

/**
 * Find the canonical tip: the deepest block in the canonical view.
 * Falls back to genesis if no other blocks are canonical.
 */
export function findCanonicalTip(ctx: NodeContext): Hash {
  const canonical = ctx.consensus.getCanonicalView();
  let bestHash = ctx.genesisHash;
  let bestDepth = 0;

  for (const key of canonical) {
    const hash = Hash.fromPrimitive(key);
    const depth = ctx.store.getAnchorDepth(hash, ctx.genesisHash);
    if (depth !== undefined && depth > bestDepth) {
      bestDepth = depth;
      bestHash = hash;
    }
  }

  return bestHash;
}

/**
 * Auto-balance a BlockSpec so that throughput (inputs == outputs) is satisfied.
 *
 * If outputs > claims (deficit): query UTXO index for unspent outputs owned by
 * our key, greedily select enough to cover the deficit, add change output for excess.
 * If claims > outputs: add a change output for the excess.
 */
function autoBalance(
  spec: BlockSpec,
  utxoIndex: UtxoIndex,
  publicKey: Uint8Array,
): BlockSpec {
  // Compute totals excluding self-claims
  const ownOutputCount = spec.outputs.length;
  let claimTotal = 0;
  let outputTotal = 0;

  for (const claim of spec.claims) {
    if (claim.index >= ownOutputCount) {
      claimTotal += claim.value;
    }
  }
  for (let i = 0; i < spec.outputs.length; i++) {
    const isSelfClaimed = spec.claims.some(
      (c) => c.index === i && i < ownOutputCount,
    );
    if (!isSelfClaimed) {
      outputTotal += spec.outputs[i].value;
    }
  }

  if (outputTotal === claimTotal) return spec;

  const newOutputs = [...spec.outputs];
  const newClaims = [...spec.claims];

  if (outputTotal > claimTotal) {
    // Need more inputs -- find UTXOs to claim
    const deficit = outputTotal - claimTotal;
    const utxos = utxoIndex.getByVerifier(SIGNATURE_CONTRACT, publicKey);

    // Phase 1: Select UTXOs
    const selected: { extendedIndex: number; value: number }[] = [];
    let gathered = 0;
    for (const utxo of utxos) {
      if (gathered >= deficit) break;
      selected.push({ extendedIndex: utxo.extendedIndex, value: utxo.value });
      gathered += utxo.value;
    }

    if (gathered < deficit) {
      // Not enough funds -- proceed anyway and let validation catch it
      return spec;
    }

    // Phase 2: Determine if change output needed
    const excess = gathered - deficit;
    if (excess > 0) {
      newOutputs.push(makeSignatureOutput(publicKey, excess));
    }

    // Phase 3: Compute claim indices based on FINAL output count
    const finalOutputCount = newOutputs.length;
    for (const utxo of selected) {
      newClaims.push({ index: finalOutputCount + utxo.extendedIndex, value: utxo.value });
    }
  } else {
    // Claims exceed outputs -- add change output
    const excess = claimTotal - outputTotal;
    newOutputs.push(makeSignatureOutput(publicKey, excess));
  }

  return { ...spec, outputs: newOutputs, claims: newClaims };
}
