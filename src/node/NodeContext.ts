import {
  AGGREGATION_CONTRACT,
  Block,
  BlockStore,
  COLLATERAL_CONTRACT,
  INSURANCE_CONTRACT,
  makeBlockStoreOutputSpace,
  RECORD_CONTRACT,
  SIGNATURE_CONTRACT,
} from '../core/Block.ts';
import { type Draft, DraftStore } from '../core/Draft.ts';
import { BlockBuilderModule } from '../core/BlockBuilderModule.ts';
import type { OutputSlot } from '../core/GeneratingEnv.ts';
import { BlockSpec, type ClaimEntry, Output, type Verifier } from '../core/BlockCreationModule.ts';
import type { BlockPayload } from '../core/Block.ts';
import { makeSignatureOutput, signatureContract } from '../contracts/SignatureContract.ts';
import {
  type OutputSpaceBlock,
  OutputSpaceModule,
  type OutputSpaceProvider,
} from '../core/OutputSpace.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { BlockVerificationService } from '../core/BlockVerificationService.ts';
import { GenerationService } from './GenerationService.ts';
import { UtxoIndexService } from './UtxoIndexService.ts';
import {
  aggregationContract,
  encodeAggregationData,
  getAggregationData,
} from '../contracts/AggregationContract.ts';
import { collateralContract } from '../contracts/CollateralContract.ts';
import { insuranceContract } from '../contracts/InsuranceContract.ts';
import { recordContract } from '../contracts/RecordContract.ts';
import type { Contract } from '../contracts/Contract.ts';
import { composeBlockPacket, composeUnsignedBlockPacket } from '../core/Block.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { Coordinator } from '../core/Coordinator.ts';
import { BlockCreator, ReactiveLayer, Strategy } from './ReactiveLayer.ts';
import { BlockCreationService } from '../core/BlockCreationService.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { SamplingService } from '../core/SamplingService.ts';
import { NodeWeightsService } from '../core/NodeWeightsService.ts';
import { GossipService } from './GossipService.ts';
import { RoutingService } from './RoutingService.ts';
import { PushAction } from './RoutingModule.ts';
import { TrustService } from '../core/TrustService.ts';
import { OutputClaimService } from '../core/OutputClaimService.ts';
import { Hash } from '../util/Hash.ts';
import { BlockRecordSet } from '../reactive/BlockRecordSet.ts';
import { verifierKey } from './UtxoIndex.ts';
import { DraftStrategy } from './strategies/DraftStrategy.ts';
import { PiggybackStrategy } from './strategies/PiggybackStrategy.ts';
import { EventLog } from '../core/EventLog.ts';
import { CollateralResolutionIndexService } from './CollateralResolutionIndexService.ts';
import { TrustGateService } from './TrustGateService.ts';

/**
 * Solidification-time value-override function. Called for every slot
 * whose origin is `'get'`. Return the final `value` for that output
 * (must be `>= defaultValue` -- the partition check at verification
 * rejects lowered values). `verifier` and `data` are frozen at
 * generation time and are supplied here for context.
 */
export type ValueOverrideFn = (
  verifier: Verifier,
  data: Uint8Array,
  defaultValue: number,
) => number;

export interface NodeConfig {
  /** Genesis block (pre-built). */
  genesis: Block;
  /** Private key for signing blocks. If provided, solidified drafts will be signed. */
  privateKey?: Uint8Array;
  /** Public key (compressed, 33 bytes). Derived from privateKey. Used for auto-balance. */
  publicKey?: Uint8Array;
  /** Strategies to register with the reactive layer */
  strategies?: Strategy[];
  /**
   * Whether PiggybackStrategy should run. Default: true. Disable in
   * application contexts where contract outputs are authoritative and
   * competitive piggybacking on every registered verifier would create
   * conflicts (e.g., the chess demo, where moves are user-driven).
   */
  enablePiggyback?: boolean;
  /** Filter: should generation run for this contract hash? Default: all enabled. */
  enableGeneration?: (contractHash: Hash) => boolean;
  /** Filter: should verification run for this contract hash? Default: all enabled. */
  enableVerification?: (contractHash: Hash) => boolean;
  /** Callback when gossip produces push actions for a block */
  onPushActions?: (actions: PushAction[], block: Block) => void;
  /** Event log for structured observability. */
  eventLog?: EventLog;
  /**
   * Demo flag: when true, ReactiveLayer skips claim-history routing and
   * floods every newly-ingested block to every connected peer (via
   * `getConnectedPeers`). Already-seen blocks are dropped early. See
   * `ScaffoldConfig.useFloodGossip`.
   */
  useFloodGossip?: boolean;
  /**
   * Provider for the set of currently-connected peer IDs. Used by flood
   * mode to build a synthetic PushAction list per block. Returns an empty
   * iterable until the network bridge is up.
   */
  getConnectedPeers?: () => Iterable<string>;
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
  readonly utxoIndex: UtxoIndexService;

  // Protocol services (convenience accessors)
  readonly consensus: ConsensusService;
  readonly sampling: SamplingService;
  readonly nodeWeights: NodeWeightsService;
  readonly gossip: GossipService;
  readonly routing: RoutingService;
  readonly trust: TrustService;
  readonly blockCreation: BlockCreationService;
  readonly outputClaims: OutputClaimService;
  readonly contractHost: ContractHostService;
  readonly blockVerification: BlockVerificationService;
  readonly generation: GenerationService;
  readonly collateralResolutionIndex: CollateralResolutionIndexService;
  readonly trustGate: TrustGateService;

  /**
   * Compatibility adapter preserving the old `execution.verifyBlock` /
   * `execution.getContract` surface used by many tests. Delegates to the
   * new `BlockVerificationService` + `ContractHostService`. New code
   * should call those services directly.
   *
   * `verifyBlock` returns `{ accepted: boolean, reason?: string }` --
   * matching the old `ExecutionResult` shape. The reason is always
   * `undefined` on acceptance and `'rejected'` on rejection; granular
   * reasons are logged by `ContractVerificationService` in the reason
   * fields of individual `ExecutionResult`s, but block-level verify is
   * a single boolean.
   */
  readonly execution: {
    verifyBlock(hash: Hash): Promise<import('../core/ContractHost.ts').ExecutionResult>;
    getContract(hash: Hash): Contract | undefined;
    registerContract(hash: Hash, contract: Contract): void;
  };

  /** Reactive block record set - notifies listeners on block add/update. */
  readonly blocks: BlockRecordSet;

  private readonly _genesisHash: Hash;
  private readonly _privateKey: Uint8Array | null;
  private readonly _publicKey: Uint8Array | null;
  private readonly _contracts: Map<string, Contract>;
  private readonly _blockCreator: BlockCreator;
  private readonly _blockBuilder: BlockBuilderModule;
  /**
   * Optional solidification-time hook that raises `value` on
   * `getOutput`-produced slots before the block is signed. See
   * docs/protocol/computation.md#output-requirements.
   */
  private _valueOverride: ValueOverrideFn | null = null;

  constructor(config: NodeConfig) {
    // 0. Store key material
    this._privateKey = config.privateKey ?? null;
    this._publicKey = config.publicKey ?? null;

    // 1. Create ProtocolContext (DI container)
    this.protocolContext = new ProtocolContext(config.eventLog);

    // 2. Get BlockStore from context (lazily created by DI)
    this.store = this.protocolContext.get(BlockStore);

    // 2b. Get DraftStore from context and wire to ConsensusService
    this.draftStore = this.protocolContext.get(DraftStore);

    // 3. Get all services from ProtocolContext.
    //    Order matters: NodeWeightsService consults SamplingService lazily,
    //    and ConsensusService consults NodeWeightsService for its
    //    effective-weight callback. Wire both before constructing
    //    ConsensusService so its callback resolves to the live propagation.
    this.sampling = this.protocolContext.get(SamplingService);
    this.nodeWeights = this.protocolContext.get(NodeWeightsService);
    this.nodeWeights.setDraftStore(this.draftStore);
    this.consensus = this.protocolContext.get(ConsensusService);
    this.consensus.setDraftStore(this.draftStore);
    this.trust = this.protocolContext.get(TrustService);

    // 3b. UtxoIndex -- DI-registered so GenerationService can reach it
    this.utxoIndex = this.protocolContext.get(UtxoIndexService);

    this.gossip = new GossipService(this.protocolContext, this.utxoIndex);
    this.routing = new RoutingService(this.protocolContext, this.gossip);
    this.blockCreation = this.protocolContext.get(BlockCreationService);
    this.outputClaims = this.protocolContext.get(OutputClaimService);
    this.contractHost = this.protocolContext.get(ContractHostService);
    this.blockVerification = this.protocolContext.get(BlockVerificationService);
    this.generation = this.protocolContext.get(GenerationService);

    // 3c. TrustGate + supporting CollateralResolutionIndex. Both are
    //     node-policy (src/node/), not protocol primitives. Constructed
    //     eagerly so their listeners bind during NodeContext init.
    //     Consumed by FetchManager / PiggybackStrategy in later phases.
    this.collateralResolutionIndex = this.protocolContext.get(
      CollateralResolutionIndexService,
    );
    this.trustGate = this.protocolContext.get(TrustGateService);

    // Compat adapter for tests that still expect `execution.verifyBlock`.
    const bvs = this.blockVerification;
    const host = this.contractHost;
    this.execution = {
      verifyBlock: (hash: Hash) => bvs.verify(hash),
      getContract: (hash: Hash) => host.getContract(hash),
      registerContract: (hash: Hash, contract: Contract) => host.registerContract(hash, contract),
    };

    // 4. Create Coordinator
    this.coordinator = this.protocolContext.get(Coordinator);

    // 5. Create a BlockCreator that uses BlockCreationService.
    //    Auto-balances throughput if a publicKey is configured.
    //    Composed Blocks carry their canonical wire bytes on `block.raw`,
    //    so NetworkBridge and StorageManager can replay them as-is.
    const blockCreationService = this.blockCreation;
    const publicKey = this._publicKey;
    const utxoIndex = this.utxoIndex;
    const store = this.store;
    const contractHost = this.contractHost;
    const ctxLogger = this.protocolContext.logger('autoBalance');
    this._blockCreator = {
      createBlock: (spec, privateKey) => {
        const balanced = publicKey
          ? autoBalance(
            spec,
            utxoIndex,
            publicKey,
            makeBlockStoreOutputSpace(store),
            store,
            (h) => contractHost.getOutputNamespaces(h),
            ctxLogger,
          )
          : spec;
        let payload: BlockPayload;
        try {
          payload = blockCreationService.buildBlock(balanced);
        } catch (e) {
          console.debug('createBlock failed:', (e as Error).message);
          return null;
        }
        return privateKey
          ? composeBlockPacket(payload, privateKey)
          : composeUnsignedBlockPacket(payload);
      },
    };

    // 5b. BlockBuilderModule -- single core entry point for turning a
    // ready draft into a signed block. Subsumes the bulk of
    // _solidifyDraft's previous logic (anchor pick, claim lowering,
    // self-claim insertion, aggregation patch, value override, signing).
    // The provider's valueOverride and privateKey getters look up live
    // values on `this` (the configured override may change at runtime via
    // setValueOverride; the private key is captured once at construction).
    const nodeCtx = this;
    this._blockBuilder = new BlockBuilderModule({
      store: this.store,
      createBlock: (spec, key) => this._blockCreator.createBlock(spec, key),
      get valueOverride() {
        return nodeCtx._valueOverride;
      },
      get privateKey() {
        return nodeCtx._privateKey;
      },
    });

    // 5c. Register built-in contracts with the ContractHost.
    this._contracts = new Map<string, Contract>();
    this._registerBuiltinContract(AGGREGATION_CONTRACT, aggregationContract);
    this._registerBuiltinContract(COLLATERAL_CONTRACT, collateralContract);
    this._registerBuiltinContract(INSURANCE_CONTRACT, insuranceContract);
    this._registerBuiltinContract(RECORD_CONTRACT, recordContract);
    this._registerBuiltinContract(SIGNATURE_CONTRACT, signatureContract);

    // 5d. Create DraftManager with GenerationService as its GeneratorProvider
    //     and install the cancel hook so a rejecting generation can clean
    //     up the draft.
    this.draftManager = new DraftManager(this.draftStore, this.consensus, this.generation);
    this.generation.setCancelHook((draftId) => this.draftManager.cancelDraft(draftId));
    // Wire the node's own pubkey into generation so `requireSignature`
    // can check whether this node is the right signer for any draft it
    // produces. Without this, every `requireSignature(...)` rejects.
    if (this._publicKey) this.generation.setSignerPubkey(this._publicKey);
    // Note: DraftManager.checkMargin and its canonicality listener were
    // removed -- anchor-chain Rule 1/2 in ConsensusModule is stricter
    // than the old margin check. See docs/protocol/draft-blocks.md.

    // 5e. Eagerly mirror canonicality into the UtxoIndex. Resolve via
    //     BlockStore first, then DraftStore: consensus fires for both
    //     phantom drafts and real blocks.
    this.consensus.onCanonicalityChange((hash, canonical) => {
      const block = this.store.get(hash);
      if (block) {
        if (canonical) this.utxoIndex.blockBecameCanonical(block);
        else this.utxoIndex.blockBecameNonCanonical(block);
        return;
      }
      const draft = this.draftStore.get(hash);
      if (draft) {
        if (canonical) this.utxoIndex.draftBecameCanonical(draft);
        else this.utxoIndex.draftBecameNonCanonical(draft);
      }
    });

    // 5f. Wire claim resolutions to gossip claim history.
    //     When a claim resolves, add it to claim history and route the
    //     claiming block toward the claimed output. FetchManager also
    //     subscribes to outputClaims.onResolution for its own response
    //     detection — both listeners fire in parallel.
    this.outputClaims.onResolution((claimant, target) => {
      const source = this.store.get(target.block);
      if (!source) return;
      const output = source.outputs[target.outputIndex];
      if (!output) return;
      const vk = verifierKey(output.verifier.contract, output.verifier.params);
      this.gossip.notifyClaimResolved(claimant, vk, output.value, target.block);
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
    //    Default enableGeneration to registered contracts EXCEPT SIGNATURE
    //    (signature outputs have no generation semantics -- they're
    //    consumed by whoever holds the matching private key, not "generated
    //    against"). Otherwise every autoBalance-produced change output
    //    would trigger a spurious draft that reserves it against future
    //    funding needs.
    const contracts = this._contracts;
    const enableGeneration = config.enableGeneration ??
      ((hash: Hash) => contracts.has(hash.toHex()) && !Hash.equals(hash, SIGNATURE_CONTRACT));
    const draftStrategy = new DraftStrategy(
      { enableGeneration },
      this.generation,
      this.utxoIndex,
    );
    // DraftStrategy tracks in-flight per {block, outputIndex}. When a
    // draft releases an unused pre-queue output, tell the strategy so
    // it can clear the corresponding in-flight entry.
    this.generation.setOutputReleasedHook((block, outputIndex) => {
      draftStrategy.complete(block, outputIndex);
    });
    // PiggybackStrategy needs ReactiveLayer.dispatchActions for its
    // out-of-cycle triggers (trust transitions, late UTXO arrivals,
    // settled verifications). ReactiveLayer doesn't exist yet, so we
    // bind via a late-resolved holder.
    const reactiveLayerRef: { current?: ReactiveLayer } = {};
    const piggybackStrategy = new PiggybackStrategy({
      trustGate: this.trustGate,
      blockVerification: this.blockVerification,
      blockStore: this.store,
      consensus: this.consensus,
      utxoIndex: this.utxoIndex,
      outputClaims: this.outputClaims,
      dispatcher: {
        dispatchActions: (actions) => reactiveLayerRef.current?.dispatchActions(actions),
      },
      outputSpace: () => makeBlockStoreOutputSpace(this.store),
      logger: this.protocolContext.logger('piggyback'),
    });

    const enablePiggyback = config.enablePiggyback ?? true;
    const strategies: Strategy[] = [
      draftStrategy,
      ...(enablePiggyback ? [piggybackStrategy] : []),
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
      onPushActions: config.onPushActions,
      onBlockProcessed: (block: Block) => {
        blocks.add(block);
      },
      useFloodGossip: config.useFloodGossip ?? false,
      getConnectedPeers: config.getConnectedPeers,
    });
    reactiveLayerRef.current = this.reactiveLayer;

    // 9. Wire draft solidification: when a draft becomes ready, build and process it.
    //    Release inFlight slots BEFORE solidification so that when the new
    //    block is processed, DraftStrategy has room to create follow-on drafts.
    this.draftStore.onTransition((draft) => {
      if (draft.status.phase !== 'readyToSolidify') return;
      for (const c of draft.claims) {
        draftStrategy.complete(c.producer, c.outputIndex);
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
    this.contractHost.registerContract(hash, contract);
  }

  /**
   * Configure the solidification-time value-override hook. Called for
   * every `getOutput` slot before the block is signed. See
   * docs/protocol/computation.md#output-requirements.
   *
   * Only one hook is installed at a time; passing `null` clears it.
   */
  setValueOverride(fn: ValueOverrideFn | null): void {
    this._valueOverride = fn;
  }

  /** Internal: register a contract on both the local registry and the host. */
  private _registerBuiltinContract(hash: Hash, contract: Contract): void {
    this._contracts.set(hash.toHex(), contract);
    this.contractHost.registerContract(hash, contract);
  }

  /** Create a block from a spec, with auto-balance and optional signing. */
  createBlock(spec: BlockSpec, privateKey: Uint8Array | null): Block | null {
    return this._blockCreator.createBlock(spec, privateKey);
  }

  /**
   * Solidify a ready draft into a real block and process it. Delegates
   * the structural work (anchor pick, claim lowering, self-claim insertion,
   * aggregation patch, value override, signing) to BlockBuilderModule.
   * Handles the draft-side bookkeeping: cancel before processing the new
   * block so the draft's phantom claims clear out of OutputClaimService
   * and consensus before the real block is evaluated.
   */
  private _solidifyDraft(draft: Draft): void {
    const result = this._blockBuilder.build(draft);

    if (!result.ok) {
      // For now, both `awaitingAnchor` and other failures fail the
      // draft. Park-and-retry on aggregation arrival is a future
      // BlockBuilderService responsibility; until that lands, callers
      // see the same outcome as before, except the draft now persists
      // in `failed` status with the reason for debugging.
      const reason = 'awaitingAnchor' in result
        ? `awaiting anchor (${result.missing.length} producers unbridged)`
        : result.reason;
      this.draftManager.cancelDraft(draft.draftId, reason);
      return;
    }

    const block = result.block;
    // Remove the draft from consensus + cancel its generator handle
    // BEFORE processing the published block so the draft's phantom
    // claims are cleared out before the real block (which claims the
    // same outputs) is evaluated. The draft itself is then transitioned
    // to `solidified` so it persists in the store referencing its block.
    this.draftManager.detachDraft(draft.draftId);
    this.draftStore.transition(draft.draftId, { phase: 'solidified', block });
    this.reactiveLayer.processBlock(block, null);
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
 * True iff any of the block's claims resolves to a verifier whose
 * contract declares SIGNATURE_CONTRACT in its outputNamespaces. Walks
 * the anchor's extended vector to resolve external claim indices; own-
 * output claims (index < ownOutputCount) are resolved directly from
 * `spec.outputs`.
 *
 * This is a leaf-block-friendly resolver. Aggregation blocks and
 * complex cases where claims resolve deeper than the anchor's own
 * outputs return false (autoBalance proceeds normally) -- the partition
 * check at verification time catches any actual violation.
 */
function ownsSignatureNamespace(
  spec: BlockSpec,
  store: BlockStore,
  outputSpace: OutputSpaceModule,
  getOutputNamespaces: (contractHash: Hash) => Hash[],
): boolean {
  const ownOutputCount = spec.outputs.length;

  for (const claim of spec.claims) {
    let claimedVerifier: Verifier | undefined;
    if (claim.index < ownOutputCount) {
      claimedVerifier = spec.outputs[claim.index]?.verifier;
    } else {
      // External claim: index into output_space(anchor). Resolve via
      // OutputSpaceModule so self-claims and aggregate subtrees are
      // handled correctly (the legacy hand-rolled walk silently lost
      // self-claims).
      const extIdx = claim.index - ownOutputCount;
      const target = outputSpace.resolveOutputSpaceIndex(spec.anchor, extIdx);
      if (target) {
        const producer = store.get(target.block);
        claimedVerifier = producer?.outputs[target.outputIndex]?.verifier;
      }
    }
    if (!claimedVerifier) continue;
    const namespaces = getOutputNamespaces(claimedVerifier.contract);
    if (namespaces.some((h) => Hash.equals(h, SIGNATURE_CONTRACT))) {
      return true;
    }
  }
  return false;
}

/**
 * Auto-balance a BlockSpec so that throughput (inputs == outputs) is satisfied.
 *
 * If outputs > claims (deficit): query UTXO index for unspent outputs owned by
 * our key, greedily select enough to cover the deficit, add change output for
 * excess, and emit claim indices resolved against the anchor's extended
 * vector via OutputSpaceModule -- the producer's local index would only be
 * valid when the anchor is the producer itself.
 *
 * If claims > outputs: add a change output for the excess and shift any
 * pre-existing external claim indices by one (adding an own output moves
 * the own/external boundary forward).
 */
function autoBalance(
  spec: BlockSpec,
  utxoIndex: UtxoIndexService,
  publicKey: Uint8Array,
  outputSpace: OutputSpaceModule,
  store: BlockStore,
  getOutputNamespaces: (contractHash: Hash) => Hash[],
  logger: { warn?: (event: string, data?: Record<string, unknown>) => void } | undefined,
): BlockSpec {
  // Namespace gate: if any claim's contract declares SIGNATURE_CONTRACT as an
  // owned namespace, autoBalance cannot drop a change output there without
  // violating the namespace partition rule. The contract is responsible for
  // emitting creator compensation itself in that case. See
  // docs/protocol/computation.md#output-namespaces.
  if (ownsSignatureNamespace(spec, store, outputSpace, getOutputNamespaces)) {
    logger?.warn?.('skipChangeOutput', {
      reason: 'SIGNATURE_CONTRACT namespace owned by claimed verifier',
    });
    return spec;
  }

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

    // Phase 1: Select UTXOs. Resolve each candidate's position in the
    // anchor's extended vector; skip any that don't survive that far
    // (already claimed on the way down, aggregated away, etc.).
    // A child claim indexes into the anchor's POST-SUBTREE vector (the
    // survivors after the anchor's own claims), not the anchor's full
    // extended vector. computeOutputSpaceIndex does exactly that mapping:
    // it is computeClaimIndex followed by mapOriginalToSurviving over the
    // anchor's claims.
    const selected: { postSubtreeIdx: number; value: number }[] = [];
    let gathered = 0;
    for (const utxo of utxos) {
      if (gathered >= deficit) break;
      const postSubtreeIdx = outputSpace.computeOutputSpaceIndex(spec.anchor, {
        block: utxo.blockHash,
        outputIndex: utxo.outputIndex,
      });
      if (postSubtreeIdx === undefined) continue;
      selected.push({ postSubtreeIdx, value: utxo.value });
      gathered += utxo.value;
    }

    if (gathered < deficit) {
      // Not enough reachable funds -- proceed anyway and let validation catch it
      return spec;
    }

    // Phase 2: Determine if change output needed
    const excess = gathered - deficit;
    if (excess > 0) {
      newOutputs.push(makeSignatureOutput(publicKey, excess));
      // Shift any pre-existing external claim indices by 1 because adding
      // an own output moves the extended-vector boundary forward. Mirrors
      // the same shift in branch 2 below.
      for (let i = 0; i < newClaims.length; i++) {
        if (newClaims[i].index >= ownOutputCount) {
          newClaims[i] = { ...newClaims[i], index: newClaims[i].index + 1 };
        }
      }
    }

    // Phase 3: Emit claim indices against the final own-output count.
    //   claim.index = finalOwnCount + positionInAnchorPostSubtree
    const finalOwnCount = newOutputs.length;
    for (const u of selected) {
      newClaims.push({ index: finalOwnCount + u.postSubtreeIdx, value: u.value });
    }
  } else {
    // Claims exceed outputs -- add change output.
    // Shift any external claim indices by 1 because adding an own output
    // moves the extended-vector boundary forward by one.
    const excess = claimTotal - outputTotal;
    newOutputs.push(makeSignatureOutput(publicKey, excess));
    for (let i = 0; i < newClaims.length; i++) {
      if (newClaims[i].index >= ownOutputCount) {
        newClaims[i] = { ...newClaims[i], index: newClaims[i].index + 1 };
      }
    }
  }

  return { ...spec, outputs: newOutputs, claims: newClaims };
}
