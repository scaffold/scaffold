import { Hash } from '../src/util/Hash.ts';
import { Block, BlockStore } from '../src/core/Block.ts';
import { cloneBlockForReception } from './testutil/cloneBlock.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { ConsensusService } from '../src/core/ConsensusService.ts';
import { SamplingService } from '../src/core/SamplingService.ts';
import { TrustService } from '../src/core/TrustService.ts';
import { BlockCreationService } from '../src/core/BlockCreationService.ts';
import { ContractHostService } from '../src/core/ContractHostService.ts';
import { BlockVerificationService } from '../src/core/BlockVerificationService.ts';
import { BlockReceivedResult, Coordinator } from '../src/core/Coordinator.ts';
import { BlockAwareness, PushAction } from '../src/node/RoutingModule.ts';
import { GossipService } from '../src/node/GossipService.ts';
import { RoutingService } from '../src/node/RoutingService.ts';
import { UtxoIndex, verifierKey } from '../src/node/UtxoIndex.ts';
import { OutputClaimService } from '../src/core/OutputClaimService.ts';

/** Result of SimNode.receiveBlock: protocol result + routing push actions. */
export interface SimBlockResult extends BlockReceivedResult {
  pushActions: PushAction[];
}

/** Simple set-based block awareness tracker. */
class SetAwareness implements BlockAwareness {
  private readonly known = new Set<string>();

  has(hash: Hash): boolean {
    return this.known.has(hash.toPrimitive());
  }

  add(hash: Hash): void {
    this.known.add(hash.toPrimitive());
  }
}

/** A simulated node running the full protocol stack. */
export class SimNode {
  readonly id: string;
  readonly ctx: ProtocolContext;
  readonly store: BlockStore;
  readonly coordinator: Coordinator;
  readonly consensus: ConsensusService;
  readonly sampling: SamplingService;
  readonly trust: TrustService;
  readonly gossip: GossipService;
  readonly routing: RoutingService;
  readonly blockCreation: BlockCreationService;
  readonly contractHost: ContractHostService;
  readonly blockVerification: BlockVerificationService;

  /**
   * Compatibility shim used by older integration tests. Delegates to the
   * new `contractHost` / `blockVerification` services; new code should
   * call those directly.
   */
  readonly execution: {
    registerContract(hash: Hash, contract: import('../src/contracts/Contract.ts').Contract): void;
    getContract(hash: Hash): import('../src/contracts/Contract.ts').Contract | undefined;
    verifyBlock(hash: Hash): Promise<import('../src/core/ContractHost.ts').ExecutionResult>;
  };

  constructor(id: string) {
    this.id = id;
    this.ctx = new ProtocolContext();

    // Eagerly initialize all services so they're wired up
    this.store = this.ctx.get(BlockStore);
    this.consensus = this.ctx.get(ConsensusService);
    this.sampling = this.ctx.get(SamplingService);
    this.trust = this.ctx.get(TrustService);

    // UtxoIndex: eagerly mirror canonicality. SimNetwork has no
    // DraftStore wired, so only real-block events need handling.
    const outputClaims = this.ctx.get(OutputClaimService);
    const utxoIndex = new UtxoIndex(this.store);
    this.consensus.onCanonicalityChange((hash, canonical) => {
      const block = this.store.get(hash);
      if (!block) return;
      if (canonical) utxoIndex.blockBecameCanonical(block);
      else utxoIndex.blockBecameNonCanonical(block);
    });

    this.gossip = new GossipService(this.ctx, utxoIndex);
    this.routing = new RoutingService(this.ctx, this.gossip);
    this.blockCreation = this.ctx.get(BlockCreationService);
    this.contractHost = this.ctx.get(ContractHostService);
    this.blockVerification = this.ctx.get(BlockVerificationService);
    this.coordinator = this.ctx.get(Coordinator);

    const host = this.contractHost;
    const bvs = this.blockVerification;
    this.execution = {
      registerContract: (hash, contract) => host.registerContract(hash, contract),
      getContract: (hash) => host.getContract(hash),
      verifyBlock: (hash) => bvs.verify(hash),
    };

    // Wire claim resolutions to gossip claim history
    outputClaims.onResolution((claimant, target) => {
      const source = this.store.get(target.block);
      if (!source) return;
      const output = source.outputs[target.outputIndex];
      if (!output) return;
      const vk = verifierKey(output.verifier.contract, output.verifier.params);
      this.gossip.notifyClaimResolved(claimant, vk, output.value, target.block);
    });
  }

  /** Process a received block through coordinator and routing. */
  receiveBlock(input: Block, fromPeer: string | null): SimBlockResult {
    // Mint a per-node atom so cross-node delivery in tests doesn't share
    // mutable transit state (fromConnections / toConnections) the way a
    // real PeerConnection's per-deserialize atoms wouldn't.
    const block = cloneBlockForReception(input);
    const result = this.coordinator.blockReceived(block, fromPeer);
    const pushActions: PushAction[] = [];
    const listener = (action: PushAction) => pushActions.push(action);
    this.routing.onPushAction(listener);
    this.routing.blockReceived(block.hash, fromPeer);
    // Remove the temporary listener
    // deno-lint-ignore no-explicit-any
    const listeners = (this.routing as any).pushActionListeners as ((action: PushAction) => void)[];
    const idx = listeners.indexOf(listener);
    if (idx !== -1) listeners.splice(idx, 1);
    return { ...result, pushActions };
  }
}

/** In-memory multi-node simulation network. */
export class SimNetwork {
  private readonly nodes = new Map<string, SimNode>();

  /** Create and register a new node. */
  addNode(id: string): SimNode {
    const node = new SimNode(id);
    this.nodes.set(id, node);

    // Connect all nodes to each other via routing
    for (const [otherId, otherNode] of this.nodes) {
      if (otherId === id) continue;
      node.routing.addPeer(otherId, otherId, new SetAwareness());
      otherNode.routing.addPeer(id, id, new SetAwareness());
    }

    return node;
  }

  /** Get a node by id. */
  getNode(id: string): SimNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Broadcast a block to all nodes.
   * The source node receives it as self-originated (fromPeer=null).
   * All other nodes receive it from the source node.
   */
  deliverToAll(block: Block, sourceNodeId: string): Map<string, SimBlockResult> {
    const results = new Map<string, SimBlockResult>();

    for (const [nodeId, node] of this.nodes) {
      const fromPeer = nodeId === sourceNodeId ? null : sourceNodeId;
      const result = node.receiveBlock(block, fromPeer);
      results.set(nodeId, result);
    }

    return results;
  }

  /**
   * Process push actions from a block received result.
   * Delivers the block to each target peer.
   */
  processPushActions(
    sourceNodeId: string,
    block: Block,
    pushActions: PushAction[],
  ): Map<string, SimBlockResult> {
    const results = new Map<string, SimBlockResult>();

    for (const action of pushActions) {
      const targetNode = this.nodes.get(action.peer);
      if (!targetNode) continue;
      if (targetNode.store.has(block.hash)) continue;

      const result = targetNode.receiveBlock(block, sourceNodeId);
      results.set(action.peer, result);
    }

    return results;
  }
}
