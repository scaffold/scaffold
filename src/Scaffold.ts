import { Block } from './core/Block.ts';
import { composeUnsignedBlockPacket } from './core/Packet.ts';
import { Output } from './core/BlockCreationModule.ts';
import { NodeConfig, NodeContext } from './node/NodeContext.ts';
import { BlockProcessor, PutManager, PutRequest, PutResult } from './node/PutManager.ts';
import { FetchHandle, FetchManager, FetchOptions, Verifier } from './node/FetchManager.ts';
import { FetchNotifyStrategy } from './node/strategies/FetchNotifyStrategy.ts';
import { Strategy } from './node/ReactiveLayer.ts';

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

        const result = nodeContext.blockCreation.buildBlock(resolvedSpec);
        if (!result.ok) return null;
        return composeUnsignedBlockPacket(result.blueprint).block;
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

  /** Expert access to internal context */
  get context(): NodeContext {
    return this.nodeContext;
  }
}
