import { Block, BlockStore, AGGREGATION_CONTRACT } from '../core/Block.ts';
import { DraftStore } from '../core/BlockDraft.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { ContractGenerator } from '../core/ContractGenerator.ts';
import { aggregationContract } from '../core/AggregationContract.ts';
import { type ContractFn } from '../core/ContractEnv.ts';
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
import { ConflictService } from '../core/ConflictService.ts';
import { SamplingService } from '../core/SamplingService.ts';
import { GossipService } from '../core/GossipService.ts';
import { TrustService } from '../core/TrustService.ts';
import { OutputClaimService } from '../core/OutputClaimService.ts';
import { BlockBlueprint } from '../core/BlockCreationModule.ts';
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
  readonly conflict: ConflictService;
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
    this.conflict = this.protocolContext.get(ConflictService);
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
    const contracts = new Map<string, ContractFn>();
    contracts.set(AGGREGATION_CONTRACT.toHex(), aggregationContract);

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
    this.sampling.onVerificationChange((hash) => {
      const block = this.store.get(hash);
      if (block) this.blocks.notifyChanged(block);
    });
    this.trust.onCollateralChange((targetHash) => {
      const block = this.store.get(targetHash);
      if (block) this.blocks.notifyChanged(block);
    });

    // 7. Create built-in DraftStrategy and combine with user strategies
    const draftStrategy = new DraftStrategy(
      { enableGeneration: config.enableGeneration },
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
      conflict: this.conflict,
      sampling: this.sampling,
      strategies,
      blockCreator,
      draftManager: this.draftManager,
      onNotifyFetch: config.onNotifyFetch,
      onBlockProcessed: (block: Block) => {
        blocks.add(block);
      },
    });

    // 9. Process genesis block through coordinator directly
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

  /** Get the genesis block hash (first block in store) */
  get genesisHash(): Hash {
    return this._genesisHash;
  }
}
