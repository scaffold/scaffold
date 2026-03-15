import { composeUnsignedBlockPacket } from './core/Packet.ts';
import { BlockBlueprint, Output } from './core/BlockCreationModule.ts';
import { NodeContext } from './node/NodeContext.ts';
import { BlockProcessor, PutManager, PutRequest, PutResult } from './node/PutManager.ts';
import { FetchHandle, FetchManager, FetchOptions, Verifier } from './node/FetchManager.ts';
import { FetchNotifyStrategy } from './node/strategies/FetchNotifyStrategy.ts';
import { Strategy } from './node/ReactiveLayer.ts';
import { BlockRecordSet } from './reactive/BlockRecordSet.ts';

export interface ScaffoldConfig {
  /** Genesis block configuration */
  genesis: { outputs: Output[] };
  /** Strategies to register */
  strategies?: Strategy[];
}

export class Scaffold {
  private readonly nodeContext: NodeContext;
  private readonly putManager: PutManager;
  private readonly fetchManager: FetchManager;

  constructor(config: ScaffoldConfig) {
    // 1. Create FetchManager and the strategy that notifies it
    this.fetchManager = new FetchManager();
    const fetchNotifyStrategy = new FetchNotifyStrategy(this.fetchManager);

    // 2. Prepend FetchNotifyStrategy to user-provided strategies
    const strategies: Strategy[] = [
      fetchNotifyStrategy,
      ...(config.strategies ?? []),
    ];

    // 3. Create NodeContext with notifyFetch wired to FetchManager
    const fetchManager = this.fetchManager;
    this.nodeContext = new NodeContext({
      genesis: config.genesis,
      strategies,
      onNotifyFetch: (verifierKey, result) => {
        fetchManager.notify(verifierKey, result);
      },
    });

    // 4. Create PutManager with a BlockProcessor that delegates to NodeContext.
    const nodeContext = this.nodeContext;
    const processor: BlockProcessor = {
      buildBlock: (spec) => {
        // Resolve anchor: if the spec's anchor isn't in the store,
        // fall back to the genesis hash (canonical tip selection).
        let anchorHash = spec.anchor;
        if (!nodeContext.store.has(anchorHash)) {
          anchorHash = nodeContext.genesisHash;
        }
        const resolvedSpec = { ...spec, anchor: anchorHash };

        let blueprint: BlockBlueprint;
        try {
          blueprint = nodeContext.blockCreation.buildBlock(resolvedSpec);
        } catch (e) {
          console.debug('buildBlock failed:', (e as Error).message);
          return null;
        }
        return composeUnsignedBlockPacket(blueprint).block;
      },
      processBlock: (block) => {
        nodeContext.processBlock(block);
      },
    };

    this.putManager = new PutManager(processor);
  }

  /** Request a computation result and subscribe to canonical state changes. */
  fetch(verifier: Verifier, options: FetchOptions): FetchHandle {
    return this.fetchManager.fetch(verifier, options);
  }

  /** Put data into the network */
  put(request: PutRequest): PutResult {
    return this.putManager.put(request);
  }

  /** Close the scaffold instance */
  async close(): Promise<void> {
    // Cleanup - stub for now (will be fleshed out with plugin lifecycle)
  }

  /** Reactive block record set for observing block graph changes. */
  get blocks(): BlockRecordSet {
    return this.nodeContext.blocks;
  }

  /** Expert access to internal context */
  get context(): NodeContext {
    return this.nodeContext;
  }
}
