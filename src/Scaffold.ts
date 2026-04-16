import { secp } from './util/secp.ts';
import { Block } from './core/Block.ts';
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
import { NetworkPlugin } from './node/NetworkManager.ts';
import { PushAction } from './node/RoutingModule.ts';
import { SignalingService } from './node/SignalingService.ts';
import { NetworkProvider } from './interfaces/network.ts';
import { bin2hex } from './util/hex.ts';
import { EventLog, ScopedLogger } from './core/EventLog.ts';

export interface ScaffoldConfig {
  /** Private key for signing blocks. Defaults to a random key. */
  privateKey?: Uint8Array;
  /** Pre-built genesis block. Defaults to the well-known genesis. */
  genesis?: Block;
  /** Strategies to register */
  strategies?: Strategy[];
  /** Network transport plugins. When provided, enables P2P networking. */
  plugins?: NetworkPlugin[];
  /** Network providers for signaling (e.g. WebrtcProvider). */
  networkProviders?: NetworkProvider[];
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
  private readonly signalingService?: SignalingService;

  /** Structured event log. Available for debugging and introspection. */
  readonly eventLog: EventLog;

  constructor(config: ScaffoldConfig = {}) {
    const privateKey = config.privateKey ?? secp.utils.randomPrivateKey();
    const publicKey = secp.getPublicKey(privateKey, true);

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

      // Create SignalingService if network providers are given
      if (config.networkProviders && config.networkProviders.length > 0) {
        this.signalingService = new SignalingService({
          selfPrivateKey: privateKey,
          selfPublicKey: publicKey,
          networkProviders: config.networkProviders,
          sendRelay: (to, from, payload) => {
            this.networkBridge!.broadcastSignal(to, from, payload);
          },
          onNewConnection: (transport) => {
            this.networkBridge!.addConnection(transport);
          },
        });
      }

      this.networkBridge = new NetworkBridge({
        plugins: config.plugins,
        store: nodeContext.store,
        routing: nodeContext.routing,
        processBlock: (block, peerId) => {
          nodeContext.processBlock(block, peerId);
        },
        signalingService: this.signalingService,
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

        // Every non-genesis block carries an aggregation marker output
        const outputs = [...spec.outputs, makeAggregationOutput()];

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

  /** Connect to bootstrap addresses. Requires network plugins. */
  connect(addresses: string[]): void {
    this.networkBridge?.bootstrap(addresses);
  }

  /** Initiate a direct connection to a remote peer via signaling relay. */
  async connectToPeer(remotePublicKey: Uint8Array): Promise<void> {
    if (!this.signalingService) {
      throw new Error('No signaling service configured -- provide networkProviders in config');
    }
    await this.signalingService.initiate(remotePublicKey);
  }

  /** Close the scaffold instance and all network connections. */
  close(): void {
    this.signalingService?.dispose();
    this.networkBridge?.close();
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
