import { secp } from './util/secp.ts';
import { AGGREGATION_CONTRACT, Block } from './core/Block.ts';
import { makeAggregationOutput } from './contracts/AggregationContract.ts';
import type { Contract } from './contracts/Contract.ts';
import { Hash } from './util/Hash.ts';
import { findCanonicalTip, NodeContext } from './node/NodeContext.ts';
import { BlockProcessor, PutManager, PutRequest, PutResult } from './node/PutManager.ts';
import { FetchHandle, FetchManager, FetchOptions, Verifier } from './node/FetchManager.ts';
import { FetchNotifyStrategy } from './node/strategies/FetchNotifyStrategy.ts';
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
  /** Enable structured event logging for debugging. Default: true. */
  enableLogging?: boolean;
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

    // 0. Create EventLog (enabled by default)
    this.eventLog = (config.enableLogging !== false)
      ? new EventLog({ console: true })
      : new EventLog();

    // 1. Create FetchManager and the strategy that notifies it
    this.fetchManager = new FetchManager();
    const fetchNotifyStrategy = new FetchNotifyStrategy(this.fetchManager);

    // 2. Prepend FetchNotifyStrategy to user-provided strategies
    const strategies: Strategy[] = [
      fetchNotifyStrategy,
      ...(config.strategies ?? []),
    ];

    // 3. Create NodeContext with notifyFetch wired to FetchManager.
    //    If network plugins are provided, onPushActions is set up after
    //    the bridge is created (see step 6).
    const fetchManager = this.fetchManager;
    let pushActionHandler: ((actions: PushAction[], block: Block) => void) | undefined;
    this.nodeContext = new NodeContext({
      genesis,
      privateKey,
      publicKey,
      strategies,
      enableGeneration: config.enableGeneration,
      enableVerification: config.enableVerification,
      eventLog: this.eventLog,
      onNotifyFetch: (verifierKey, result) => {
        fetchManager.notify(verifierKey, result);
      },
      hasFetchSubscription: (key) => fetchManager.hasSubscription(key),
      onPushActions: (actions, block) => {
        pushActionHandler?.(actions, block);
      },
    });

    // 6. Create NetworkBridge if plugins are provided
    if (config.plugins && config.plugins.length > 0) {
      const nodeContext = this.nodeContext;
      const selfIdHex = bin2hex(publicKey);

      this.networkBridge = new NetworkBridge({
        plugins: config.plugins,
        selfPrivateKey: privateKey,
        selfPublicKey: publicKey,
        store: nodeContext.store,
        packetStore: nodeContext.packetStore,
        routing: nodeContext.routing,
        processBlock: (block, peerId) => {
          nodeContext.processBlock(block, peerId);
        },
        selfId: selfIdHex,
        logger: this.eventLog ? new ScopedLogger(this.eventLog, 'network') : undefined,
      });
      pushActionHandler = (actions, block) => {
        this.networkBridge!.handlePushActions(actions, block);
      };
    }

    // 4. Create PutManager with a BlockProcessor that delegates to NodeContext.
    const nodeContext = this.nodeContext;
    const processor: BlockProcessor = {
      buildBlock: (spec) => {
        // Resolve anchor: if the spec's anchor isn't in the store,
        // select the canonical tip (deepest canonical block).
        let anchorHash = spec.anchor;
        if (!nodeContext.store.has(anchorHash)) {
          anchorHash = findCanonicalTip(nodeContext);
        }

        // Every non-genesis block carries an aggregation marker output.
        // Only append if the spec doesn't already carry one (the draft
        // solidification path pre-populates it and has already computed
        // claim indices against that layout -- appending again would
        // shift claim targets by one).
        const hasAggMarker = spec.outputs.some((o) =>
          o.data.length === 0 &&
          o.verifier.contract.toHex() === AGGREGATION_CONTRACT.toHex()
        );
        const outputs = hasAggMarker
          ? spec.outputs
          : [...spec.outputs, makeAggregationOutput()];

        // Delegate to NodeContext's createBlock (auto-balances + signs)
        return nodeContext.createBlock(
          { ...spec, anchor: anchorHash, outputs },
          privateKey,
        );
      },
      processBlock: (block) => {
        nodeContext.processBlock(block);
      },
    };

    this.putManager = new PutManager(processor);
  }

  /** Register a contract for generation and verification at runtime. */
  registerContract(hash: Hash, contract: Contract): void {
    this.nodeContext.registerContract(hash, contract);
  }

  /** Request a computation result and subscribe to canonical state changes. */
  fetch(verifier: Verifier, options: FetchOptions): FetchHandle {
    return this.fetchManager.fetch(verifier, options);
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
    // Destruct the protocol context so services with Symbol.dispose
    // (e.g. ExecutionQueueService clears its setTimeout handles) can
    // clean up.
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
