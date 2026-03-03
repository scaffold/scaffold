# Scaffold Client Interface

## Overview

Scaffold is a pure TypeScript library for peer-to-peer consensus. Browsers request data, peers compete to resolve first, and correct work is rewarded. The library handles all protocol mechanics (conflict detection, consensus, gossip, sampling, verification, aggregation) autonomously. The user interacts through two methods:

- **`fetch`** — request the result of a computation and receive updates as canonical state evolves
- **`put`** — publish data to the network (contracts, user inputs, manual responses)

All impure functionality (networking, persistence, timekeeping, entropy, logging) is injected via plugins. The core library is 100% pure and runs in any environment (browser, Node, Deno, test harness).

## Core API

```typescript
class Scaffold {
  constructor(config: ScaffoldConfig)

  /**
   * Request a computation result and subscribe to canonical state changes.
   *
   * Publishes an incentive block to the network, then monitors for response
   * blocks satisfying the verifier. Calls `onResult` whenever the canonical
   * result changes (new result, stronger result, reorg to different result,
   * or result lost entirely).
   *
   * The computation graph is a DAG — contracts can request other contracts.
   * `fetch` is a memoized functional call: if the result already exists and
   * is canonical, the callback fires immediately.
   */
  fetch(verifier: Verifier, options: FetchOptions): FetchHandle

  /**
   * Publish a block with one or more outputs.
   *
   * Use cases:
   *   1. Upload a contract: put({ data: wasmBytes })
   *   2. Publish user data (e.g. keypresses): put({ data, contract: gameHash })
   *   3. Manually respond to a fetch: put({ data: result, satisfies: verifier })
   *
   * UTXO mechanics (which outputs to claim, how to balance accounts) are
   * handled internally by the library. The returned hash identifies the
   * published block.
   */
  put(request: PutRequest): PutResult

  /**
   * Tear down the node. Stops all autonomous behaviors, closes peer
   * connections, flushes pending storage writes, cancels pending
   * computations. Returns when cleanup is complete.
   */
  close(): Promise<void>

  /**
   * Expert access to internal context for advanced use cases.
   * Exposes protocol modules, block store, peer state, etc.
   * Most users should never need this.
   */
  get context(): NodeContext
}
```

### fetch

```typescript
interface Verifier {
  /** Hash of the contract to execute. */
  contract: Hash
  /** Contract-specific parameters. */
  params: Uint8Array
}

interface FetchOptions {
  /**
   * Called whenever the canonical result for this verifier changes.
   * May be called multiple times as consensus evolves:
   *   - First call: fastest available result
   *   - Subsequent calls: stronger result found, reorg, verification update
   *   - Called with null if the previous result loses canonicality
   */
  onResult: (result: FetchResult | null) => void

  /** Cancel the subscription. */
  signal?: AbortSignal

  /**
   * Which result to prefer when multiple candidates exist.
   *   - 'fastest': first valid result (default)
   *   - 'strongest': highest canonical weight
   *   - 'latest': most recent result
   */
  mode?: 'fastest' | 'strongest' | 'latest'

  /**
   * Minimum canonical weight before reporting a result. Higher values
   * mean more confidence but slower first response. Default: 0 (report
   * immediately).
   */
  minCanonicality?: number

  /** Debounce rapid state changes (ms). Default: 0. */
  debounceMs?: number

  /**
   * Economic incentive for computation. Higher values attract more
   * generators. Default: from config.economics.defaultIncentive.
   */
  incentive?: number
}

interface FetchResult {
  /** The computation output. */
  data: Uint8Array

  /** Hash of the block containing this result. */
  block: Hash

  /**
   * Canonical weight — a measure of how settled this result is.
   * Increases over time as more blocks build on top.
   */
  canonicality: number

  /** Whether we have independently verified this result. */
  verified: boolean
}

interface FetchHandle {
  /** Stop listening for results and clean up. */
  close(): void
}
```

**Lifecycle of a fetch call:**

1. Library checks if a canonical block already satisfies this verifier. If so, calls `onResult` immediately.
2. Publishes an incentive block to the network, offering a reward for the computation.
3. Peers with the contract registered see the incentive and race to compute the result.
4. When a response block is received and becomes canonical, `onResult` is called.
5. If a stronger result appears (higher canonicality), `onResult` is called again.
6. If the result loses canonicality (reorg), `onResult(null)` is called, then the new canonical result (if any).
7. When the fetch handle is closed (or signal aborted), the subscription is cleaned up.

**Deduplication:** Multiple fetches for the same verifier share a single incentive block and subscription internally.

### put

```typescript
interface PutRequest {
  /** The data payload. */
  data: Uint8Array

  /**
   * Which contract this output belongs to. Determines how the data is
   * interpreted and who can claim it. Default: generic data contract
   * (content-addressed storage).
   */
  contract?: Hash

  /**
   * If this block responds to a specific fetch request. The library
   * handles claiming the incentive output and setting up UTXO
   * relationships. Use this when manually responding to a computation
   * request.
   */
  satisfies?: Verifier

  /**
   * Declared computational weight. Higher values increase the block's
   * influence on consensus but must be backed by real work (or will be
   * challenged). Default: 1.
   */
  weight?: number
}

interface PutResult {
  /** Hash of the published block. */
  hash: Hash
}
```

`put` is synchronous in the common case — the block is created, signed, and processed locally. Network propagation happens asynchronously in the background.

## Configuration

```typescript
interface ScaffoldConfig {
  // -- Identity --

  /**
   * ECDSA private key for signing blocks. If omitted, a random key is
   * generated. Provide this to maintain a persistent identity across
   * sessions.
   */
  privateKey?: Uint8Array

  // -- Network --

  /**
   * Bootstrap peer addresses. The library connects to these on startup,
   * then discovers additional peers through gossip.
   * Example: ['wss://bootstrap1.example.com', 'wss://bootstrap2.example.com']
   */
  bootstrapPeers?: string[]

  /**
   * Network identifier. Nodes only communicate with peers on the same
   * network. Default: 'main'.
   */
  network?: string

  // -- Plugins (all optional; the library provides no defaults) --

  /**
   * Network transport plugins. Each provides a protocol for connecting
   * to peers (WebSocket, WebRTC, etc.). If empty, the node runs in
   * local-only mode (useful for testing).
   */
  networkPlugins?: NetworkPlugin[]

  /**
   * Persistent storage plugin. Blocks and protocol state survive restarts.
   * If omitted, everything is in-memory only.
   */
  storagePlugin?: StoragePlugin

  /**
   * Time provider. Needed for scheduling autonomous behaviors (aggregation
   * intervals, gossip timing, GC). If omitted, no autonomous behaviors
   * run — the library only processes blocks when explicitly given them.
   */
  timePlugin?: TimePlugin

  /**
   * Entropy provider. Used for sampling decisions, key generation (if no
   * privateKey given), and gossip randomization. If omitted, uses a
   * zero-entropy provider (deterministic, for testing).
   */
  entropyPlugin?: EntropyPlugin

  /** Logging plugins. Receive structured log events. */
  loggingPlugins?: LoggingPlugin[]

  // -- Contracts --

  /**
   * JavaScript implementations of contracts, keyed by contract hash.
   * Used before WASM support is available, or for contracts that are
   * more naturally expressed in JS.
   *
   * When a contract needs to be executed (to generate a response or
   * verify a block), the library looks up the contract hash here first.
   * If not found, falls back to WASM execution (when available).
   */
  contracts?: Record<string, ContractFn>

  // -- Economics --

  economics?: EconomicsConfig

  // -- Resources --

  resources?: ResourceConfig

  // -- Features --

  features?: FeatureConfig

  // -- Genesis --

  /**
   * Genesis block outputs. These define the initial state of the network:
   * initial token distribution, root contracts, etc. All nodes on the
   * same network must agree on genesis.
   */
  genesis?: GenesisConfig
}
```

### Plugin Interfaces

All plugins are interfaces with no base class. The library never calls platform APIs directly.

```typescript
/**
 * Network transport plugin. Provides a way to establish peer connections.
 */
interface NetworkPlugin {
  /** Protocol identifier, e.g. 'websocket@1', 'webrtc@1'. */
  protocol: string

  /**
   * Compatible protocols this plugin can connect to.
   * E.g. a WebSocket client connects to 'websocket@1/server'.
   */
  connectsTo?: string[]

  /** Start listening / initialize. Called once on startup. */
  start(driver: NetworkDriver): void

  /** Clean up. */
  stop(): void
}

/**
 * Callbacks the library provides to network plugins.
 */
interface NetworkDriver {
  /** A new peer connection has been established. */
  onConnection(conn: TransportConnection): void

  /** Resolve a bootstrap address to a connection attempt. */
  resolveBootstrap(address: string): void
}

/**
 * A single peer connection (provided by network plugin to the library).
 */
interface TransportConnection {
  /** Send data reliably (ordered, guaranteed delivery). */
  sendReliable(data: Uint8Array): void

  /** Send data best-effort (unordered, may drop). */
  sendFast(data: Uint8Array): void

  /** Called by the library when data is received. Set by library. */
  onData: ((data: Uint8Array) => void) | null

  /** Called when the connection closes. Set by library. */
  onClose: (() => void) | null

  /** Close the connection. */
  close(): void

  /** Maximum message size in bytes (for fragmentation). */
  maxMessageSize?: number
}

/**
 * Persistent storage plugin.
 */
interface StoragePlugin {
  set(namespace: number, key: Uint8Array, value?: Uint8Array): void
  get(namespace: number, key: Uint8Array): Promise<Uint8Array | undefined> | Uint8Array | undefined
  list(namespace: number): AsyncIterable<{ key: Uint8Array; value: Uint8Array }>
}

/**
 * Time provider plugin.
 */
interface TimePlugin {
  now(): number
  setTimeout(cb: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(cb: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
}

/**
 * Entropy provider plugin.
 */
interface EntropyPlugin {
  /** Returns a random float in [0, 1). */
  random(): number
  /** Returns cryptographically random bytes. */
  randomBytes(size: number): Uint8Array
}

/**
 * Logging plugin.
 */
interface LoggingPlugin {
  log(event: LogEvent): void
}

interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error'
  system: string
  message: string
  data?: Record<string, unknown>
  timestamp: number
}
```

### Contract Registration

```typescript
/**
 * A JavaScript implementation of a contract. Used for both generation
 * (producing outputs) and verification (checking correctness).
 */
type ContractFn = (ctx: ContractContext) => void | Promise<void>

/**
 * Execution context provided to contract functions.
 */
interface ContractContext {
  /** The contract parameters from the verifier. */
  readonly params: Uint8Array

  /** The number of available inputs. */
  readonly inputCount: number

  /** Read an input by index. */
  getInput(index: number): Uint8Array

  /**
   * Emit an output. For generators, this is the computation result.
   * For verifiers, this is the expected result (compared against the
   * block's actual output to determine validity).
   */
  emit(data: Uint8Array, options?: { contract?: Hash; value?: number }): void

  /**
   * Request another contract's result. This is how the computation
   * DAG is formed — contracts can depend on other contracts.
   * Returns the cached/canonical result if available.
   */
  request(verifier: Verifier): Promise<Uint8Array>

  /** Declare computational weight. */
  declareWeight(weight: number): void
}
```

### Economics Configuration

```typescript
interface EconomicsConfig {
  /** Default incentive for fetch requests. Default: 10. */
  defaultIncentive?: number

  /** How much to reward generators relative to compute time. */
  generationReward?: (verifier: Verifier, computeTimeMs: number) => number

  /**
   * Minimum collateral required relative to declared work.
   * Higher values make fraud more expensive.
   */
  minimumCollateral?: (declaredWork: number) => number
}
```

### Resource Configuration

```typescript
interface ResourceConfig {
  /**
   * Maximum concurrent computations (generation + verification).
   * Default: navigator.hardwareConcurrency or 4.
   */
  maxConcurrentJobs?: number

  /** Memory limit in MB. Default: 1024. */
  maxMemoryMb?: number

  /**
   * Maximum outbound bandwidth in bytes/sec per connection.
   * Default: 10240 (10 KB/s).
   */
  maxBandwidthPerConnection?: number

  /**
   * Target number of peer connections. The library will try to maintain
   * approximately this many connections via peer discovery.
   * Default: 8.
   */
  targetPeerCount?: number

  /** Maximum blocks to keep in memory before GC. Default: 10000. */
  maxBlocks?: number
}
```

### Feature Configuration

```typescript
interface FeatureConfig {
  /**
   * Enable reactive aggregation. When canonical leaves share an anchor,
   * the library automatically aggregates them if likely to win the race.
   * Default: true.
   */
  aggregation?: boolean | AggregationConfig

  /**
   * Enable sampling and verification. The library picks canonical blocks
   * to verify based on statistical priority, executes the contract, and
   * updates trust weights. Default: true.
   */
  sampling?: boolean | SamplingConfig

  /**
   * Enable generation. When incentive blocks appear, the library
   * automatically generates responses for contracts it can execute.
   * Default: true.
   */
  generation?: boolean

  /**
   * Enable disputing. When verification fails, the library creates
   * dispute blocks (AGAINST collateral). Default: true.
   */
  disputing?: boolean

  /**
   * Enable collateralization. Blocks must post economic stakes that
   * can be claimed on dispute. Default: false (for development).
   */
  collateralization?: boolean
}

interface AggregationConfig {
  /** Maximum blocks to aggregate at once. Default: 3. */
  maxChildren?: number

  /**
   * Minimum number of canonical leaves sharing an anchor before
   * attempting aggregation. Default: 2.
   */
  minLeaves?: number
}

interface SamplingConfig {
  /**
   * Minimum sampling priority before verifying a block. Higher values
   * mean fewer verifications but less security. Default: 0.01.
   */
  minPriority?: number
}
```

### Genesis Configuration

```typescript
interface GenesisConfig {
  /**
   * Initial outputs in the genesis block. All nodes must agree on these.
   * Typically includes: initial token allocations, root contract outputs.
   */
  outputs: Array<{
    contract: Hash
    data: Uint8Array
    value?: number
  }>
}
```

## Expert API

For the 1% of users who need deeper access:

```typescript
interface NodeContext {
  /** The protocol context — access to all protocol modules. */
  readonly protocol: ProtocolContext

  /** The block store — query blocks by hash, walk chains. */
  readonly store: BlockStore

  /** The coordinator — process blocks, inspect canonical view. */
  readonly coordinator: Coordinator

  /** This node's public key (derived from private key). */
  readonly publicKey: Uint8Array

  /** Current peer connections. */
  readonly peers: ReadonlyMap<string, PeerInfo>

  /**
   * Subscribe to internal events. Returns an unsubscribe function.
   *
   * Events:
   *   'blockReceived': a new block was processed
   *   'canonicalityChanged': canonical view changed
   *   'peerConnected': new peer connection
   *   'peerDisconnected': peer dropped
   *   'verificationComplete': a block was verified
   */
  on(event: string, callback: (...args: unknown[]) => void): () => void
}
```

## Design Principles

1. **Pure core.** The library has zero platform dependencies. Every impure operation (setTimeout, crypto.getRandomValues, WebSocket, localStorage) flows through plugins. You can run the entire protocol in a test with mocked time, deterministic entropy, and simulated networking.

2. **Reactive autonomy.** After construction, the library drives itself. Block reception triggers canonicality changes; canonicality changes trigger aggregation, sampling, verification, and dispute — all without user intervention. The user only calls `fetch` and `put`.

3. **Plugin-injected impurity.** No default plugins are bundled. Platform-specific packages (`scaffold/browser`, `scaffold/deno`) provide sensible defaults. This keeps the core library zero-dependency and tree-shakeable.

4. **Minimal surface, maximal depth.** Two methods cover 99% of use cases. The remaining 1% accesses internal modules through `context`. No intermediate abstraction layer — the expert API exposes the real protocol objects, not a watered-down wrapper.

5. **Computation as DAG.** `fetch` is a memoized functional call. Contracts can `request` other contracts, forming a computation dependency graph. `put` provides leaf inputs (user data, contract code). The protocol handles caching, invalidation, and re-computation as canonical state evolves.

## Examples

### Basic: fetch a computation

```typescript
import { Scaffold } from 'scaffold'
import { browserPlugins } from 'scaffold/browser'

const scaffold = new Scaffold({
  ...browserPlugins(),
  bootstrapPeers: ['wss://boot.example.com'],
})

const handle = scaffold.fetch(
  { contract: weatherContractHash, params: encode({ city: 'London' }) },
  {
    onResult: (result) => {
      if (result) {
        console.log('Temperature:', decode(result.data).temperature)
        console.log('Confidence:', result.canonicality)
      } else {
        console.log('Result lost — waiting for new canonical result')
      }
    },
  },
)

// Later:
handle.close()
await scaffold.close()
```

### Basic: publish data

```typescript
// Upload a contract
const { hash: contractHash } = scaffold.put({ data: contractWasmBytes })

// Publish user input for a game contract
scaffold.put({
  data: encode({ key: 'ArrowUp', frame: 42 }),
  contract: gameContractHash,
})
```

### Register a JS contract

```typescript
const scaffold = new Scaffold({
  ...browserPlugins(),
  contracts: {
    [addContractHash]: async (ctx) => {
      const a = decodeNumber(ctx.getInput(0))
      const b = decodeNumber(ctx.getInput(1))
      ctx.emit(encodeNumber(a + b))
    },
    [weatherContractHash]: async (ctx) => {
      const params = decodeParams(ctx.params)
      // Contracts can request other contracts
      const apiKey = await ctx.request({
        contract: configContractHash,
        params: encode({ key: 'weather-api-key' }),
      })
      const temp = fetchWeather(params.city, apiKey)
      ctx.emit(encode({ temperature: temp }))
    },
  },
})
```

### Test with mocked time and deterministic entropy

```typescript
import { Scaffold } from 'scaffold'
import { MockTimePlugin, SeededEntropyPlugin, MockNetworkPlugin }
  from 'scaffold/testing'

const time = new MockTimePlugin()
const network = new MockNetworkPlugin(time)

const node1 = new Scaffold({
  networkPlugins: [network.createNode()],
  timePlugin: time,
  entropyPlugin: new SeededEntropyPlugin(42n),
})

const node2 = new Scaffold({
  networkPlugins: [network.createNode()],
  timePlugin: time,
  entropyPlugin: new SeededEntropyPlugin(43n),
})

// Connect nodes
network.connect(node1, node2)

// Advance time to trigger autonomous behaviors
time.advance(1000)
```

## Questions & Notes

**Why not Promises for fetch?** A fetch is a long-lived subscription, not a one-shot request. The canonical result may change many times as consensus evolves — a new block arrives, a reorg happens, verification updates confidence. Callbacks model this naturally. For one-shot usage, wrap in a promise:

```typescript
function fetchOnce(scaffold, verifier): Promise<FetchResult> {
  return new Promise((resolve) => {
    const handle = scaffold.fetch(verifier, {
      onResult: (result) => {
        if (result && result.canonicality > 10) {
          handle.close()
          resolve(result)
        }
      },
    })
  })
}
```

**Why not events/EventEmitter?** Events are stringly-typed and hard to compose. Callbacks with handles are simpler, more typesafe, and explicit about lifecycle (close to unsubscribe).

**What about streaming results?** An `AsyncIterator` adapter could be built on top of the callback API if needed. The callback is the primitive; iterators are sugar.
