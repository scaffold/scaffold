import { secp } from './util/secp.ts';
import { Block } from './core/Block.ts';
import type { Contract } from './contracts/Contract.ts';
import { Hash } from './util/Hash.ts';
import { findCanonicalTip, NodeContext, type ValueOverrideFn } from './node/NodeContext.ts';
import { PutManager, PutRequest, PutResult } from './node/PutManager.ts';
import { OutputHandler, OutputHandlerRegistry } from './core/OutputHandlerRegistry.ts';
import { FetchHandle, FetchInput, FetchManager, FetchResult } from './node/FetchManager.ts';
import type { Verifier } from './core/BlockCreationModule.ts';
import { Strategy } from './node/ReactiveLayer.ts';
import { BlockRecordSet } from './reactive/BlockRecordSet.ts';
import { getGenesisBlock } from './genesis.ts';
import { NetworkBridge } from './node/NetworkBridge.ts';
import { TransportPlugin } from './interfaces/transport.ts';
import { PushAction } from './node/RoutingModule.ts';
import { bin2hex } from './util/hex.ts';
import { EventLog, ScopedLogger } from './core/EventLog.ts';

export interface ScaffoldConfig {
  /** Private key for signing blocks. Defaults to a random key. */
  privateKey?: Uint8Array;
  /** Pre-built genesis block. Defaults to the well-known genesis. */
  genesis?: Block;
  /** Strategies to register */
  strategies?: Strategy[];
  /** Transport plugins. When provided, enables P2P networking. */
  plugins?: TransportPlugin[];
  /** Filter: should generation run for this contract hash? Default: all enabled. */
  enableGeneration?: (contractHash: Hash) => boolean;
  /** Filter: should verification run for this contract hash? Default: all enabled. */
  enableVerification?: (contractHash: Hash) => boolean;
  /**
   * Whether PiggybackStrategy should run. Default: true. Applications that
   * drive their own block construction (chess, interactive games) typically
   * want this off -- piggyback would otherwise generate competing claims
   * on every registered verifier.
   */
  enablePiggyback?: boolean;
  /** Enable structured event logging for debugging. Default: true. */
  enableLogging?: boolean;
  /**
   * Node-level policy for outgoing fetch incentives. Called per-verifier on
   * fetch(). Defaults to 0 (no economic participation; gossip still routes
   * on claim history).
   */
  getOutgoingIncentive?: (verifier: Verifier) => number;
  /**
   * Demo flag: when true, disable claim-history routing and per-message
   * RPC paths and instead flood every newly-ingested atom (Block, Signal,
   * Request) to every connected peer except the sender. Already-seen
   * atoms are dropped on receipt. Default: false.
   *
   * Caveats:
   * - Incompatible with `PiggybackStrategy` delayed broadcast: the
   *   `submitBlock` action still calls `RoutingModule` directly, which is
   *   inert in flood mode. Set `enablePiggyback: false` alongside this.
   * - Per-atom seen-sets are unbounded; intended for demos / testnet, not
   *   long-running mainnet nodes.
   */
  useFloodGossip?: boolean;
}

export class Scaffold {
  private readonly nodeContext: NodeContext;
  private readonly putManager: PutManager;
  private readonly fetchManager: FetchManager;
  private readonly networkBridge?: NetworkBridge;
  private readonly _publicKey: Uint8Array;

  /** Structured event log. Available for debugging and introspection. */
  readonly eventLog: EventLog;

  constructor(config: ScaffoldConfig = {}) {
    const privateKey = config.privateKey ?? secp.utils.randomPrivateKey();
    const publicKey = secp.getPublicKey(privateKey, true);
    this._publicKey = publicKey;

    const genesis = config.genesis ?? getGenesisBlock();

    this.eventLog = (config.enableLogging !== false)
      ? new EventLog({ console: true })
      : new EventLog();

    // 1. Create NodeContext (protocol layer + reactive + piggyback).
    let pushActionHandler: ((actions: PushAction[], block: Block) => void) | undefined;
    let getConnectedPeers: (() => Iterable<string>) | undefined;
    this.nodeContext = new NodeContext({
      genesis,
      privateKey,
      publicKey,
      strategies: config.strategies,
      enableGeneration: config.enableGeneration,
      enableVerification: config.enableVerification,
      enablePiggyback: config.enablePiggyback,
      eventLog: this.eventLog,
      onPushActions: (actions, block) => {
        pushActionHandler?.(actions, block);
      },
      useFloodGossip: config.useFloodGossip ?? false,
      getConnectedPeers: () => getConnectedPeers ? getConnectedPeers() : [],
    });

    // 2. Create FetchManager, wired to the already-constructed node services.
    const nodeContext = this.nodeContext;
    this.fetchManager = new FetchManager({
      dispatcher: nodeContext.reactiveLayer,
      consensus: nodeContext.consensus,
      outputClaims: nodeContext.outputClaims,
      blockStore: nodeContext.store,
      trustGate: nodeContext.trustGate,
      blockVerification: nodeContext.blockVerification,
      contractHost: nodeContext.contractHost,
      config: {
        getOutgoingIncentive: config.getOutgoingIncentive ?? (() => 0),
      },
      findCanonicalTip: () => findCanonicalTip(nodeContext),
      logger: this.eventLog ? new ScopedLogger(this.eventLog, 'fetch') : undefined,
    });

    // 3. Create NetworkBridge if plugins are provided
    if (config.plugins && config.plugins.length > 0) {
      const selfIdHex = bin2hex(publicKey);

      this.networkBridge = new NetworkBridge({
        plugins: config.plugins,
        selfPrivateKey: privateKey,
        selfPublicKey: publicKey,
        store: nodeContext.store,
        routing: nodeContext.routing,
        processBlock: (block, peerId) => {
          nodeContext.processBlock(block, peerId);
        },
        selfId: selfIdHex,
        logger: this.eventLog ? new ScopedLogger(this.eventLog, 'network') : undefined,
        useFloodGossip: config.useFloodGossip ?? false,
      });
      pushActionHandler = (actions, block) => {
        this.networkBridge!.handlePushActions(actions, block);
      };
      // Yield logical peerIds (deduplicated across connections) so flood
      // mode emits one PushAction per peer; transport.sendBlock fans
      // out to every active connection sharing that peerId.
      getConnectedPeers = () => {
        const seen = new Set<string>();
        for (const peer of this.networkBridge!.peers.values()) {
          seen.add(peer.peerId);
        }
        return seen;
      };
    }

    // 4. PutManager: end-user-facing draft API. Routes through the
    //    DraftManager bottleneck. See src/node/PutManager.ts.
    this.putManager = new PutManager(nodeContext.draftManager);
  }

  /** Register a contract for generation and verification at runtime. */
  registerContract(hash: Hash, contract: Contract): void {
    this.nodeContext.registerContract(hash, contract);
  }

  /**
   * Register a handler for `env.getOutput(verifier)` calls during generation.
   * `runningContract` scopes the handler to contracts whose verifier's
   * contract matches. Handlers for the same contract run in registration
   * order; each returns `null` to defer to the next, or a concrete
   * `{value, data}` to terminate the chain. Returns an unsubscribe fn.
   *
   * See docs/protocol/computation.md#host-handler-registration.
   */
  registerOutputHandler(runningContract: Hash, handler: OutputHandler): () => void {
    return this.nodeContext.protocolContext
      .get(OutputHandlerRegistry)
      .registerUser(runningContract, handler);
  }

  /**
   * Configure the solidification-time value-override hook. Called per
   * `getOutput` slot before signing; lets the node raise the output's
   * `value` (only). See docs/protocol/computation.md#output-requirements.
   */
  setValueOverride(fn: ValueOverrideFn | null): void {
    this.nodeContext.setValueOverride(fn);
  }

  /**
   * Request a computation result from the network.
   *
   * With `verify: true`, returns a Promise that resolves with the first
   * canonical claim whose response contract accepts locally. Otherwise
   * returns a `FetchHandle` with streaming callbacks that track canonical
   * changes. See docs/design/fetch.md for the full surface.
   */
  fetch<T = unknown>(input: FetchInput<T> & { verify: true }): Promise<FetchResult<T>>;
  fetch<T = unknown>(input: FetchInput<T>): FetchHandle;
  fetch<T = unknown>(
    input: FetchInput<T>,
  ): FetchHandle | Promise<FetchResult<T>> {
    return this.fetchManager.fetch<T>(input);
  }

  /** Put data into the network */
  put(request: PutRequest): PutResult {
    return this.putManager.put(request);
  }

  /** Start network plugins (if configured). */
  start(): void {
    this.networkBridge?.start();
  }

  /** Connect to a bootstrap address via the plugin that accepts this protocol. */
  bootstrapConnection(protocol: string, address: string): void {
    if (!this.networkBridge) {
      throw new Error('No network plugins configured');
    }
    this.networkBridge.bootstrapConnection(protocol, address);
  }

  /** Initiate a direct authenticated connection to a remote peer. */
  async connectToPeer(remotePublicKey: Uint8Array): Promise<void> {
    if (!this.networkBridge) {
      throw new Error('No network plugins configured');
    }
    await this.networkBridge.connectToPeer(remotePublicKey);
  }

  /** Subscribe to peer-connected events. peerId is the pubkey hex for authenticated peers. */
  onPeerConnected(cb: (peerId: string) => void): void {
    this.networkBridge?.onPeerConnected(cb);
  }

  /** Subscribe to peer-disconnected events. */
  onPeerDisconnected(cb: (peerId: string) => void): void {
    this.networkBridge?.onPeerDisconnected(cb);
  }

  /**
   * Send a stored block directly to a specific peer, bypassing gossip.
   *
   * Used for manual bootstrapping of claim-history routing in demos/tests:
   * the recipient will process the block with fromPeer=<this peer>, populating
   * receivedFirst and claim history as if it had arrived via gossip.
   */
  sendBlockToPeer(blockHash: Hash, peerId: string): void {
    if (!this.networkBridge) {
      throw new Error('No network plugins configured');
    }
    const block = this.nodeContext.store.get(blockHash);
    if (!block) {
      throw new Error(`Block not found in store: ${blockHash.toHex()}`);
    }
    this.networkBridge.sendBlockToPeer(block, peerId);
  }

  /** This node's compressed secp256k1 public key. */
  get publicKey(): Uint8Array {
    return this._publicKey;
  }

  /** This node's public key as a hex string (the canonical peerId for authenticated peers). */
  get publicKeyHex(): string {
    return bin2hex(this._publicKey);
  }

  /** Close the scaffold instance and all network connections. */
  async close(): Promise<void> {
    await this.networkBridge?.close();
    await this.nodeContext.protocolContext.destruct();
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
