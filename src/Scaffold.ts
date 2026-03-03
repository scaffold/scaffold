import { Block, createBlock } from './core/Block.ts';
import { Output } from './core/BlockCreationModule.ts';
import { NodeContext, NodeConfig } from './node/NodeContext.ts';
import { PutManager, PutRequest, PutResult, BlockProcessor } from './node/PutManager.ts';
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

  constructor(config: ScaffoldConfig) {
    this.nodeContext = new NodeContext({
      genesis: config.genesis,
      strategies: config.strategies,
    });

    // Create PutManager with a BlockProcessor that delegates to NodeContext.
    // The BlockProcessor resolves the anchor (PutManager uses a placeholder)
    // and builds the block via BlockCreationService + createBlock.
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
        const anchor = nodeContext.store.get(anchorHash);
        if (!anchor) return null;
        return createBlock(result.blueprint, anchor);
      },
      processBlock: (block) => {
        nodeContext.processBlock(block);
      },
    };

    this.putManager = new PutManager(processor);
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
