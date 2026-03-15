import { Block, BlockStore } from '../core/Block.ts';
import { composeBlockPacket, composeGenesisPacket, composeUnsignedBlockPacket } from '../core/Packet.ts';
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
import { BlockBlueprint, Output } from '../core/BlockCreationModule.ts';
import { Hash } from '../util/Hash.ts';
import { BlockRecordSet } from '../reactive/BlockRecordSet.ts';

export interface NodeConfig {
  /** Genesis block outputs (defines the network) */
  genesis: { outputs: Output[] };
  /** Strategies to register with the reactive layer */
  strategies?: Strategy[];
  /** Callback when a notifyFetch action is dispatched */
  onNotifyFetch?: (verifier: VerifierKey, result: FetchResult | null) => void;
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

  /** Reactive block record set - notifies listeners on block add/update. */
  readonly blocks: BlockRecordSet;

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

    // 7. Create ReactiveLayer with strategies
    const blocks = this.blocks;
    this.reactiveLayer = new ReactiveLayer({
      coordinator: this.coordinator,
      store: this.store,
      consensus: this.consensus,
      conflict: this.conflict,
      sampling: this.sampling,
      strategies: config.strategies ?? [],
      blockCreator,
      onNotifyFetch: config.onNotifyFetch,
      onBlockProcessed: (block: Block) => {
        blocks.add(block);
      },
    });

    // 8. Process genesis block through coordinator directly
    //    (not through reactive layer, since strategies should not fire on genesis)
    const { block: genesis } = composeGenesisPacket(config.genesis.outputs);
    this.coordinator.blockReceived(genesis, null);
    this.blocks.add(genesis);
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
