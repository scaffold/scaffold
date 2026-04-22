import { secp } from './util/secp.ts';
import { AGGREGATION_CONTRACT, Block } from './core/Block.ts';
import { makeAggregationOutput } from './contracts/AggregationContract.ts';
import type { Contract } from './contracts/Contract.ts';
import { Hash } from './util/Hash.ts';
import { findCanonicalTip, NodeContext } from './node/NodeContext.ts';
import { BlockProcessor, PutManager, PutRequest, PutResult } from './node/PutManager.ts';
import {
  FetchHandle,
  FetchInput,
  FetchManager,
  FetchResult,
} from './node/FetchManager.ts';
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
  /** Enable structured event logging for debugging. Default: true. */
  enableLogging?: boolean;
  /**
   * Node-level policy for outgoing fetch incentives. Called per-verifier on
   * fetch(). Defaults to 0 (no economic participation; gossip still routes
   * on claim history).
   */
  getOutgoingIncentive?: (verifier: Verifier) => number;
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
    this.nodeContext = new NodeContext({
      genesis,
      privateKey,
      publicKey,
      strategies: config.strategies,
      enableGeneration: config.enableGeneration,
      enableVerification: config.enableVerification,
      eventLog: this.eventLog,
      onPushActions: (actions, block) => {
        pushActionHandler?.(actions, block);
      },
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
