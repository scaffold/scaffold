import { composeBlockPacket } from './core/Packet.ts';
import { secp } from './util/secp.ts';
import { Block, SIGNATURE_CONTRACT } from './core/Block.ts';
import { makeSignatureOutput } from './contracts/SignatureContract.ts';
import { makeAggregationOutput } from './contracts/AggregationContract.ts';
import { BlockBlueprint, BlockSpec } from './core/BlockCreationModule.ts';
import { Hash } from './util/Hash.ts';
import { NodeContext } from './node/NodeContext.ts';
import { BlockProcessor, PutManager, PutRequest, PutResult } from './node/PutManager.ts';
import { FetchHandle, FetchManager, FetchOptions, Verifier } from './node/FetchManager.ts';
import { FetchNotifyStrategy } from './node/strategies/FetchNotifyStrategy.ts';
import { Strategy } from './node/ReactiveLayer.ts';
import { BlockRecordSet } from './reactive/BlockRecordSet.ts';
import { getGenesisBlock } from './genesis.ts';
import { UtxoIndex } from './node/UtxoIndex.ts';
import { NetworkBridge } from './node/NetworkBridge.ts';
import { NetworkPlugin } from './node/NetworkManager.ts';
import { PushAction } from './node/GossipModule.ts';
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
    this.eventLog = (config.enableLogging !== false) ? new EventLog({ console: true }) : new EventLog();

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
      strategies,
      enableGeneration: config.enableGeneration,
      enableVerification: config.enableVerification,
      eventLog: this.eventLog,
      onNotifyFetch: (verifierKey, result) => {
        fetchManager.notify(verifierKey, result);
      },
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
        gossip: nodeContext.gossip,
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

    // 4. Get UtxoIndex from NodeContext (created and wired there)
    const utxoIndex = this.nodeContext.utxoIndex;

    // 5. Create PutManager with a BlockProcessor that delegates to NodeContext.
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

        // Auto-balance throughput
        const balancedSpec = autoBalance(
          { ...spec, anchor: anchorHash, outputs },
          utxoIndex,
          publicKey,
        );

        let blueprint: BlockBlueprint;
        try {
          blueprint = nodeContext.blockCreation.buildBlock(balancedSpec);
        } catch (e) {
          console.debug('buildBlock failed:', (e as Error).message);
          return null;
        }
        return composeBlockPacket(blueprint, privateKey).block;
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

/**
 * Find the canonical tip: the deepest block in the canonical view.
 * Falls back to genesis if no other blocks are canonical.
 */
function findCanonicalTip(ctx: NodeContext): Hash {
  const canonical = ctx.consensus.getCanonicalView();
  let bestHash = ctx.genesisHash;
  let bestDepth = 0;

  for (const key of canonical) {
    const hash = Hash.fromPrimitive(key);
    const depth = ctx.store.getAnchorDepth(hash, ctx.genesisHash);
    if (depth !== undefined && depth > bestDepth) {
      bestDepth = depth;
      bestHash = hash;
    }
  }

  return bestHash;
}

/**
 * Auto-balance a BlockSpec so that throughput (inputs == outputs) is satisfied.
 *
 * If outputs > claims (deficit): query UTXO index for unspent outputs owned by
 * our key, greedily select enough to cover the deficit, add change output for excess.
 * If claims > outputs: add a change output for the excess.
 */
function autoBalance(
  spec: BlockSpec,
  utxoIndex: UtxoIndex,
  publicKey: Uint8Array,
): BlockSpec {
  // Compute totals excluding self-claims
  const ownOutputCount = spec.outputs.length;
  let claimTotal = 0;
  let outputTotal = 0;

  for (const claim of spec.claims) {
    if (claim.index >= ownOutputCount) {
      claimTotal += claim.value;
    }
  }
  for (let i = 0; i < spec.outputs.length; i++) {
    const isSelfClaimed = spec.claims.some(
      (c) => c.index === i && i < ownOutputCount,
    );
    if (!isSelfClaimed) {
      outputTotal += spec.outputs[i].value;
    }
  }

  if (outputTotal === claimTotal) return spec;

  const newOutputs = [...spec.outputs];
  const newClaims = [...spec.claims];

  if (outputTotal > claimTotal) {
    // Need more inputs -- find UTXOs to claim
    const deficit = outputTotal - claimTotal;
    const utxos = utxoIndex.getByVerifier(SIGNATURE_CONTRACT, publicKey);

    // Phase 1: Select UTXOs
    const selected: { extendedIndex: number; value: number }[] = [];
    let gathered = 0;
    for (const utxo of utxos) {
      if (gathered >= deficit) break;
      selected.push({ extendedIndex: utxo.extendedIndex, value: utxo.value });
      gathered += utxo.value;
    }

    if (gathered < deficit) {
      // Not enough funds -- proceed anyway and let validation catch it
      return spec;
    }

    // Phase 2: Determine if change output needed
    const excess = gathered - deficit;
    if (excess > 0) {
      newOutputs.push(makeSignatureOutput(publicKey, excess));
    }

    // Phase 3: Compute claim indices based on FINAL output count
    const finalOutputCount = newOutputs.length;
    for (const utxo of selected) {
      newClaims.push({ index: finalOutputCount + utxo.extendedIndex, value: utxo.value });
    }
  } else {
    // Claims exceed outputs -- add change output
    const excess = claimTotal - outputTotal;
    newOutputs.push(makeSignatureOutput(publicKey, excess));
  }

  return { ...spec, outputs: newOutputs, claims: newClaims };
}
