import { Block, BlockStore, createBlock, createGenesisBlock } from '../core/Block.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { Coordinator } from '../core/Coordinator.ts';
import { ReactiveLayer, Strategy, BlockCreator } from './ReactiveLayer.ts';
import { BlockCreationService } from '../core/BlockCreationService.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { ConflictService } from '../core/ConflictService.ts';
import { SamplingService } from '../core/SamplingService.ts';
import { GossipService } from '../core/GossipService.ts';
import { TrustService } from '../core/TrustService.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { Hash } from '../util/Hash.ts';

export interface NodeConfig {
  /** Genesis block outputs (defines the network) */
  genesis: { outputs: Output[] };
  /** Strategies to register with the reactive layer */
  strategies?: Strategy[];
}

/**
 * NodeContext wires together the protocol layer and the node layer.
 * Created by the Scaffold constructor.
 */
export class NodeContext {
  readonly store: BlockStore;
  readonly protocolContext: ProtocolContext;
  readonly coordinator: Coordinator;
  readonly reactiveLayer: ReactiveLayer;

  // Protocol services (convenience accessors)
  readonly consensus: ConsensusService;
  readonly conflict: ConflictService;
  readonly sampling: SamplingService;
  readonly gossip: GossipService;
  readonly trust: TrustService;
  readonly blockCreation: BlockCreationService;

  private readonly _genesisHash: Hash;

  constructor(config: NodeConfig) {
    // 1. Create ProtocolContext (DI container)
    this.protocolContext = new ProtocolContext();

    // 2. Get BlockStore from context (lazily created by DI)
    this.store = this.protocolContext.get(BlockStore);

    // 3. Get all services from ProtocolContext
    this.consensus = this.protocolContext.get(ConsensusService);
    this.conflict = this.protocolContext.get(ConflictService);
    this.sampling = this.protocolContext.get(SamplingService);
    this.gossip = this.protocolContext.get(GossipService);
    this.trust = this.protocolContext.get(TrustService);
    this.blockCreation = this.protocolContext.get(BlockCreationService);

    // 4. Create Coordinator
    this.coordinator = this.protocolContext.get(Coordinator);

    // 5. Create a BlockCreator that uses BlockCreationService
    const blockCreationService = this.blockCreation;
    const store = this.store;
    const blockCreator: BlockCreator = {
      createBlock: (spec) => {
        const result = blockCreationService.buildBlock(spec);
        if (!result.ok) return null;
        const anchorBlock = store.get(spec.anchor);
        if (!anchorBlock) return null;
        return createBlock(result.blueprint, anchorBlock);
      },
    };

    // 6. Create ReactiveLayer with strategies
    this.reactiveLayer = new ReactiveLayer({
      coordinator: this.coordinator,
      store: this.store,
      consensus: this.consensus,
      conflict: this.conflict,
      sampling: this.sampling,
      strategies: config.strategies ?? [],
      blockCreator,
    });

    // 7. Process genesis block through coordinator directly
    //    (not through reactive layer, since strategies should not fire on genesis)
    const genesis = createGenesisBlock(config.genesis.outputs);
    this.coordinator.blockReceived(genesis, null);
    this._genesisHash = genesis.hash;
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
