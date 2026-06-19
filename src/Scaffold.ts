import { secp } from './util/secp.ts';
import { Block, HASH_CONTRACT } from './core/Block.ts';
import type { Contract } from './contracts/Contract.ts';
import type { ContractPlugin } from './core/ContractPlugin.ts';
import { wasmContractPlugin } from './plugins/wasm/WasmContractPlugin.ts';
import { findRecordOutput } from './contracts/RecordContract.ts';
import { DEFAULT_KEY } from './contracts/HashContract.ts';
import { Hash } from './util/Hash.ts';
import { NodeContext, type ValueOverrideFn } from './node/NodeContext.ts';
import { PutManager, PutRequest } from './node/PutManager.ts';
import { SendHandle, SendManager, SendRequest } from './node/SendManager.ts';
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
  /**
   * Blocks to seed into the store after genesis so their blobs resolve
   * locally without peer fetch. Defaults to none -- the browser bundle ships
   * no blocks and resolves blobs via peer fetch. A Deno/CLI host can pass the
   * disk-loaded well-known blocks here (see `wellKnown.ts`, excluded from the
   * npm build); the dev demo seeds its own.
   */
  wellKnownBlocks?: Block[];
  /** Strategies to register */
  strategies?: Strategy[];
  /** Transport plugins. When provided, enables P2P networking. */
  plugins?: TransportPlugin[];
  /**
   * Signaling/relay addresses to dial on `start()`. Example: `bootstrap: ['ws://relay.scaffold.io']`.
   */
  bootstrapUrls?: (string | URL)[];
  /**
   * Contract execution plugins. Each takes a contract block and either
   * `accepts` it (returning a `Contract` impl) or passes. Plugins are
   * tried in order; the first to accept handles the block. Defaults to
   * `[wasmContractPlugin()]` when unset. Pass `[]` to disable on-chain
   * contract execution entirely (only TS-registered contracts run).
   *
   * See `src/core/ContractPlugin.ts`.
   */
  contractPlugins?: ContractPlugin<Block>[];
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
  private readonly sendManager: SendManager;
  private readonly fetchManager: FetchManager;
  private readonly networkBridge?: NetworkBridge;
  private readonly _publicKey: Uint8Array;
  private readonly _bootstrapUrls: URL[];

  /** Structured event log. Available for debugging and introspection. */
  readonly eventLog: EventLog;

  constructor(config: ScaffoldConfig = {}) {
    const privateKey = config.privateKey ?? secp.utils.randomPrivateKey();
    const publicKey = secp.getPublicKey(privateKey, true);
    this._publicKey = publicKey;

    this._bootstrapUrls = config.bootstrapUrls?.map((x) => x instanceof URL ? x : new URL(x)) ?? [];

    const genesis = config.genesis ?? getGenesisBlock();
    const wellKnownBlocks = config.wellKnownBlocks ?? [];

    this.eventLog = (config.enableLogging !== false)
      ? new EventLog({ console: true })
      : new EventLog();

    // 1. Create NodeContext (protocol layer + reactive + piggyback).
    let pushActionHandler: ((actions: PushAction[], block: Block) => void) | undefined;
    let getConnectedPeers: (() => Iterable<string>) | undefined;
    this.nodeContext = new NodeContext({
      genesis,
      wellKnownBlocks,
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
      // User-supplied plugins go in directly. When unset, we install a
      // default `wasmContractPlugin` post-construction below -- the default
      // plugin's `resolveBlob` needs FetchManager, which isn't constructed yet.
      contractPlugins: config.contractPlugins ?? [],
    });

    const nodeContext = this.nodeContext;

    // 2. PutManager + SendManager: end-user-facing draft primitives.
    //    put runs the contract generator via GenerationService; send
    //    bypasses generation and emits raw outputs via DraftManager.
    this.putManager = new PutManager(
      nodeContext.generation,
      nodeContext.draftStore,
      nodeContext.contractHost,
    );
    this.sendManager = new SendManager(
      nodeContext.draftManager,
      nodeContext.draftStore,
      nodeContext.contractHost,
    );

    // 3. Create FetchManager. Its incentive publication is delegated to
    //    SendManager so the incentive block re-emits on uncanonical for
    //    free (and the two paths share code).
    this.fetchManager = new FetchManager({
      send: (req) => this.sendManager.send(req),
      consensus: nodeContext.consensus,
      outputClaims: nodeContext.outputClaims,
      blockStore: nodeContext.store,
      trustGate: nodeContext.trustGate,
      blockVerification: nodeContext.blockVerification,
      contractHost: nodeContext.contractHost,
      config: {
        getOutgoingIncentive: config.getOutgoingIncentive ?? (() => 0),
      },
      logger: this.eventLog ? new ScopedLogger(this.eventLog, 'fetch') : undefined,
    });

    // 3a. Install the default `wasmContractPlugin` if the caller didn't supply
    //     their own plugin list. The plugin needs `resolveBlob` backed by
    //     FetchManager for stacking layer-blob lookups; can't construct earlier.
    if (config.contractPlugins === undefined) {
      const fetchMgr = this.fetchManager;
      const defaultPlugin = wasmContractPlugin({
        resolveBlob: async (hash: Hash) => {
          // Local-first: a HASH_CONTRACT publish (including the seeded
          // well-known blob blocks) carries a RECORD/'default' output whose
          // body hashes to the requested hash. Resolving from the store keeps
          // offline / single-node nodes from depending on peer fetch.
          const local = this._resolveBlobLocal(hash);
          if (local) return local;

          // Fall back to incentive-based peer fetch. `verify: true` makes
          // fetch return a Promise<FetchResult>; the surface type union also
          // covers the FetchHandle path so we cast.
          const result = await (fetchMgr.fetch({
            contract: HASH_CONTRACT,
            params: hash.toBytes(),
            verify: true,
          }) as Promise<FetchResult>);
          return result.body;
        },
      });
      nodeContext.contractHost.registerPlugin(defaultPlugin);
    }

    // 4. Create NetworkBridge if plugins are provided
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

    // The JS compiler is not a built-in. It lives outside the npm bundle
    // (src/contracts/JsCompilerContract.ts, excluded from the build); a host
    // that wants it registers it explicitly via `registerContract`, injecting
    // the well-known blob hashes. See the dev demo's compilerHashes.ts.
  }

  /**
   * Resolve a blob from the local store without touching the network.
   * Scans for a HASH_CONTRACT block carrying a RECORD/'default' output whose
   * body hashes to `hash`. Returns null when no such block is present.
   */
  private _resolveBlobLocal(hash: Hash): Uint8Array | null {
    for (const block of this.nodeContext.store.values()) {
      const record = findRecordOutput(block, DEFAULT_KEY);
      if (!record) continue;
      if (Hash.equals(Hash.digest(record.body), hash)) {
        return record.body;
      }
    }
    return null;
  }

  /** Register a contract for generation and verification at runtime. */
  registerContract(hash: Hash, contract: Contract): void {
    this.nodeContext.registerContract(hash, contract);
  }

  /**
   * Register a handler for `env.request(verifier)` calls during generation.
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
   * `request` slot before signing; lets the node raise the output's
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

  /**
   * Publish a verifier with fitting records. Returns a Promise that
   * resolves with the first block produced from the draft. The draft
   * pipeline will keep re-emitting if that block becomes uncanonical,
   * but the promise only resolves once. Use `send` if you need to
   * observe re-emissions.
   */
  put(request: PutRequest): Promise<Block> {
    return this.putManager.put(request);
  }

  /**
   * Publish a single output under the supplied verifier with the given
   * body. Returns a handle whose `close()` cancels the underlying draft.
   * `onBlock` fires for the initial emission plus every re-emission after
   * the previous block becomes uncanonical.
   */
  send(request: SendRequest): SendHandle {
    return this.sendManager.send(request);
  }

  /** Start network plugins (if configured) and dial any `bootstrap` addresses. */
  start(): void {
    this.networkBridge?.start();
    if (this._bootstrapUrls.length === 0) return;
    if (!this.networkBridge) {
      throw new Error(
        'bootstrap addresses require a transport plugin; pass `plugins: [...]` ' +
          '(a default browser transport is not yet bundled -- see TODO.md)',
      );
    }
    for (const url of this._bootstrapUrls) {
      const protocol = url.protocol.replace(/:$/, '');
      this.networkBridge.bootstrapConnection(protocol, url.host);
    }
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
