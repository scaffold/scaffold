// Design spec: docs/design/fetch.md

import { Hash } from '../util/Hash.ts';
import { Block, BlockStore, RECORD_CONTRACT } from '../core/Block.ts';
import type { Verifier } from '../core/BlockCreationModule.ts';
import type { Output } from '../core/BlockCreationModule.ts';
import { bin2hex } from '../util/hex.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { OutputClaimService } from '../core/OutputClaimService.ts';
import { BlockVerificationService } from '../core/BlockVerificationService.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import type { TrustGate, TrustStatus } from './TrustGate.ts';
import { DefaultBuilderHost } from '../core/DefaultBuilderHost.ts';
import { RecordingWalkerHost, type FieldNode } from '../core/RecordingWalkerHost.ts';
import { findRecordOutput } from '../contracts/RecordContract.ts';
import type { Action, ReactiveLayer } from './ReactiveLayer.ts';
import { ScopedLogger } from '../core/EventLog.ts';
import {
  FetchAbortError,
  InvalidatedError,
  NotImplementedError,
  SupersededError,
  VerificationRejectedError,
} from './FetchErrors.ts';

// -- Public types ----------------------------------------------------

export interface FetchInput<T = unknown> {
  contract: Hash;
  params: Uint8Array | Record<string, unknown>;

  /** Which self-claimed record on the responder block to surface. Default: empty bytes. */
  recordKey?: string | Uint8Array;

  /** Verify the response contract locally before resolving. Default: false. */
  verify?: boolean;

  /**
   * When false, build/sign the incentive block and any piggyback blocks but
   * do not broadcast them. NOT YET IMPLEMENTED — passing `false` throws
   * `NotImplementedError`. Phase 4b will wire local-only piggyback.
   */
  publish?: boolean;

  /** Cancels the subscription (does not revoke a published incentive). */
  signal?: AbortSignal;

  onIncentive?: (block: Block, outputIdx: number) => void;

  /**
   * Fires on each canonical-claim change, including when the block changes
   * but the record data does not. `null` means the last-surfaced claim was
   * invalidated with no replacement.
   */
  onClaim?: (claim: FetchClaim<T> | null) => void;

  /**
   * Fires when the record data changes. Does NOT fire when canonicality
   * transfers to a different block carrying the same data. `null` means
   * the last-surfaced result was invalidated with no replacement. Valid
   * only when verify !== true.
   */
  onResult?: (result: FetchResult<T> | null) => void;

  /** Exceptional conditions: parse errors, abort, etc. */
  onError?: (err: Error) => void;
}

export interface FetchResult<T = unknown> {
  readonly data: Uint8Array;
  /**
   * Run `contract.walkData` on `data` and return the walked value. Memoized —
   * repeated calls return the same Promise. Rejects with `SupersededError`
   * if a different canonical claim has surfaced with different data, with
   * `InvalidatedError` if the surfacing claim was invalidated with no
   * replacement, or with the underlying error if `walkData` is missing or
   * throws.
   */
  parse(): Promise<T>;
}

export interface FetchClaim<T = unknown> extends FetchResult<T> {
  readonly block: Block;
  /** Index into block.claims[] corresponding to our incentive output. */
  readonly claimIdx: number;
}

export interface FetchHandle {
  close(): void;
}

// -- Implementation types --------------------------------------------

/** A FetchResult that can be superseded or invalidated by the manager. */
class FetchResultImpl<T = unknown> implements FetchResult<T> {
  readonly data: Uint8Array;
  private _parsePromise: Promise<T> | undefined;
  private _parseReject: ((err: Error) => void) | undefined;
  private _supersededError: Error | undefined;

  constructor(
    data: Uint8Array,
    private readonly _runParse: () => Promise<T>,
  ) {
    this.data = data;
  }

  parse(): Promise<T> {
    if (this._parsePromise) return this._parsePromise;
    if (this._supersededError) return Promise.reject(this._supersededError);
    this._parsePromise = new Promise<T>((resolve, reject) => {
      this._parseReject = reject;
      this._runParse().then(resolve, reject);
    });
    return this._parsePromise;
  }

  _supersede(err: Error): void {
    if (this._supersededError) return;
    this._supersededError = err;
    this._parseReject?.(err);
  }
}

class FetchClaimImpl<T = unknown> extends FetchResultImpl<T> implements FetchClaim<T> {
  readonly block: Block;
  readonly claimIdx: number;

  constructor(
    data: Uint8Array,
    runParse: () => Promise<T>,
    block: Block,
    claimIdx: number,
  ) {
    super(data, runParse);
    this.block = block;
    this.claimIdx = claimIdx;
  }
}

/** Per-caller view of a shared subscription. */
interface Projection<T = unknown> {
  recordKey: Uint8Array;
  verify: boolean;
  onIncentive?: (block: Block, outputIdx: number) => void;
  onClaim?: (claim: FetchClaim<T> | null) => void;
  onResult?: (result: FetchResult<T> | null) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
  /** Wired only when `verify: true`. */
  promise?: {
    resolve: (result: FetchResult<T>) => void;
    reject: (err: Error) => void;
    settled: boolean;
  };
  /** The current surfaced claim for this projection. Drives supersession. */
  currentClaim?: FetchClaimImpl<T>;
  /** Cached bytes of currentClaim. Used for data-identity comparisons. */
  currentData?: Uint8Array;
  /** The block hash currently surfaced. Used for claim-transfer detection. */
  currentBlockHash?: Hash;
  /** Abort handler to detach when close() fires. */
  abortHandler?: () => void;
}

/** State shared across all projections for a single verifier. */
interface Subscription {
  verifierKey: string;
  contract: Hash;
  params: Uint8Array;
  /** The incentive output. Null while the incentive block is being built. */
  incentive: { blockHash: Hash; outputIndex: number } | null;
  /** Projections by insertion order. */
  projections: Projection[];
  /** claimant hash hex → index in claimant.claims[] resolving to our incentive. */
  knownClaimants: Map<string, number>;
  /** The currently-surfaced canonical claimant, if any. */
  currentClaimant: Hash | null;
  /** Buffered onIncentive calls — fired once the incentive lands. */
  pendingIncentiveProjections: Projection[];
}

// -- FetchManager ----------------------------------------------------

export interface FetchManagerDeps {
  dispatcher: Pick<ReactiveLayer, 'dispatchActions'>;
  consensus: ConsensusService;
  outputClaims: OutputClaimService;
  blockStore: BlockStore;
  trustGate: TrustGate;
  blockVerification: BlockVerificationService;
  contractHost: ContractHostService;
  config: {
    getOutgoingIncentive: (v: Verifier) => number;
  };
  /** Resolve the canonical anchor for a new incentive block. */
  findCanonicalTip: () => Hash;
  logger?: ScopedLogger;
}

export class FetchManager {
  private readonly subscriptions = new Map<string, Subscription>();
  /** Reverse index: claimant hash hex → list of verifier keys whose incentive it claims. */
  private readonly claimantToVerifiers = new Map<string, Set<string>>();

  constructor(private readonly deps: FetchManagerDeps) {
    // Subscribe to resolution, canonicality, trust transitions.
    this.deps.outputClaims.onResolution((claimant, target) => {
      this._onResolution(claimant, target);
    });
    this.deps.consensus.onCanonicalityChange((hash, canonical) => {
      this._onCanonicality(hash, canonical);
    });
    this.deps.trustGate.onTrustChanged((hash, status) => {
      this._onTrustChanged(hash, status);
    });
  }

  /** Public API: subscribe to a verifier with per-caller projection. */
  fetch<T = unknown>(input: FetchInput<T>): FetchHandle | Promise<FetchResult<T>> {
    if (input.publish === false) {
      throw new NotImplementedError(
        'fetch({ publish: false }) is not yet implemented (Phase 4b)',
      );
    }

    // 1. Encode params
    const params = encodeParams(input.contract, input.params, this.deps.contractHost);

    // 2. Normalize recordKey
    const recordKey = normalizeRecordKey(input.recordKey);

    // 3. Verifier key for dedup
    const verifierKey = computeVerifierKey(input.contract, params);

    // 4. Build projection
    const projection: Projection<T> = {
      recordKey,
      verify: input.verify === true,
      onIncentive: input.onIncentive,
      onClaim: input.onClaim as Projection<T>['onClaim'],
      onResult: input.onResult as Projection<T>['onResult'],
      onError: input.onError,
      signal: input.signal,
    };

    // 5. verify:true → Promise adapter
    let promiseAdapter: Promise<FetchResult<T>> | undefined;
    if (projection.verify) {
      promiseAdapter = new Promise<FetchResult<T>>((resolve, reject) => {
        projection.promise = {
          resolve,
          reject,
          settled: false,
        };
      });
    }

    // 6. Abort handler
    if (input.signal) {
      if (input.signal.aborted) {
        const err = new FetchAbortError();
        if (projection.promise) {
          projection.promise.settled = true;
          projection.promise.reject(err);
        } else {
          projection.onError?.(err);
        }
        return promiseAdapter ?? { close: () => {} };
      }
      projection.abortHandler = () => {
        this._closeProjection(verifierKey, projection as Projection, {
          reason: new FetchAbortError(),
        });
      };
      input.signal.addEventListener('abort', projection.abortHandler);
    }

    // 7. Attach or create subscription
    let sub = this.subscriptions.get(verifierKey);
    if (!sub) {
      sub = {
        verifierKey,
        contract: input.contract,
        params,
        incentive: null,
        projections: [],
        knownClaimants: new Map(),
        currentClaimant: null,
        pendingIncentiveProjections: [],
      };
      this.subscriptions.set(verifierKey, sub);
      // Publish the incentive on first subscriber.
      this._publishIncentive(sub);
    }
    sub.projections.push(projection as Projection);

    // 8. If incentive already published, fire onIncentive for this projection.
    if (sub.incentive && projection.onIncentive) {
      const block = this.deps.blockStore.get(sub.incentive.blockHash);
      if (block) projection.onIncentive(block, sub.incentive.outputIndex);
    } else if (!sub.incentive) {
      sub.pendingIncentiveProjections.push(projection as Projection);
    }

    // 9. If a current claim already exists on the subscription, deliver to the new projection.
    if (sub.currentClaimant) {
      this._refreshProjection(sub, projection as Projection);
    }

    // 10. Return the right shape
    const handle: FetchHandle = {
      close: () => {
        this._closeProjection(verifierKey, projection as Projection);
      },
    };

    // verify:true: return the Promise. The handle is implicitly owned
    // by the Promise lifecycle and auto-closes on resolve/reject.
    if (promiseAdapter) {
      const auto = (fn: () => void) =>
        promiseAdapter!.then(fn, fn);
      auto(() => handle.close());
      return promiseAdapter;
    }
    return handle;
  }

  /** Diagnostic: true if any subscription exists for the verifier. */
  hasSubscription(verifierKey: string): boolean {
    return this.subscriptions.has(verifierKey);
  }

  /** Diagnostic: the active verifier keys. */
  getActiveVerifierKeys(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** Legacy static helper kept for callers that compute the key externally. */
  static verifierKey(verifier: { contract: Hash; params: Uint8Array }): string {
    return computeVerifierKey(verifier.contract, verifier.params);
  }

  // -- Incentive publishing ------------------------------------------

  private _publishIncentive(sub: Subscription): void {
    const verifier: Verifier = { contract: sub.contract, params: sub.params };
    const value = this.deps.config.getOutgoingIncentive(verifier);

    const incentiveOutput: Output = {
      verifier: { contract: sub.contract, params: sub.params },
      value,
      data: new Uint8Array(0),
    };

    // Emit a createBlock action. The BlockCreator in NodeContext handles
    // aggregation-marker insertion and auto-balance; we just declare the
    // one output we care about.
    const action: Action = {
      type: 'createBlock',
      spec: {
        anchor: this.deps.findCanonicalTip(),
        outputs: [incentiveOutput],
        claims: [],
        declaredWeight: 0,
        aggregates: [],
        refs: [],
      },
      sign: true,
      broadcast: true,
      onCreated: (block) => {
        if (!block) {
          const err = new Error('incentive block build failed');
          // Fire onError on all projections; drop subscription.
          for (const p of sub.projections) {
            p.onError?.(err);
            if (p.promise && !p.promise.settled) {
              p.promise.settled = true;
              p.promise.reject(err);
            }
          }
          this.subscriptions.delete(sub.verifierKey);
          return;
        }
        // Find the output index for our verifier (the block creator may
        // have appended aggregation marker or change outputs).
        const outputIndex = block.outputs.findIndex((o) =>
          Hash.equals(o.verifier.contract, sub.contract) &&
          byteEquals(o.verifier.params, sub.params) &&
          // exclude any other matching verifier that is also e.g. an incentive
          // (first-match is fine here since we emitted exactly one in the spec)
          true
        );
        if (outputIndex < 0) {
          const err = new Error('incentive output missing from built block');
          for (const p of sub.projections) p.onError?.(err);
          this.subscriptions.delete(sub.verifierKey);
          return;
        }
        sub.incentive = { blockHash: block.hash, outputIndex };
        this.deps.logger?.info('incentivePublished', {
          verifier: sub.verifierKey,
          block: block.hash.toHex(),
          outputIndex,
          value,
        });
        // Fire onIncentive for pending projections.
        const pending = sub.pendingIncentiveProjections.splice(0);
        for (const p of pending) p.onIncentive?.(block, outputIndex);
      },
    };
    this.deps.dispatcher.dispatchActions([action]);
  }

  // -- Resolution / canonicality event handlers ---------------------

  private _onResolution(
    claimant: Hash,
    target: { block: Hash; outputIndex: number; claimIndex: number },
  ): void {
    // Map target to a verifier key.
    const sub = this._subForIncentive(target);
    if (!sub) return;
    const claimantKey = claimant.toHex();
    if (!sub.knownClaimants.has(claimantKey)) {
      sub.knownClaimants.set(claimantKey, target.claimIndex);
      let verifierSet = this.claimantToVerifiers.get(claimantKey);
      if (!verifierSet) {
        verifierSet = new Set();
        this.claimantToVerifiers.set(claimantKey, verifierSet);
      }
      verifierSet.add(sub.verifierKey);
    }
    // Re-evaluate the subscription against the current canonicality / trust.
    this._reevaluate(sub);
  }

  private _onCanonicality(hash: Hash, _canonical: boolean): void {
    const verifierSet = this.claimantToVerifiers.get(hash.toHex());
    if (!verifierSet) return;
    for (const vk of verifierSet) {
      const sub = this.subscriptions.get(vk);
      if (sub) this._reevaluate(sub);
    }
  }

  private _onTrustChanged(hash: Hash, _status: TrustStatus): void {
    const verifierSet = this.claimantToVerifiers.get(hash.toHex());
    if (!verifierSet) return;
    for (const vk of verifierSet) {
      const sub = this.subscriptions.get(vk);
      if (sub) this._reevaluate(sub);
    }
  }

  // -- Reevaluation -------------------------------------------------

  private _subForIncentive(
    target: { block: Hash; outputIndex: number },
  ): Subscription | undefined {
    // Look up the output's verifier; match against our subscriptions.
    const block = this.deps.blockStore.get(target.block);
    if (!block) return undefined;
    const output = block.outputs[target.outputIndex];
    if (!output) return undefined;
    const vk = computeVerifierKey(output.verifier.contract, output.verifier.params);
    const sub = this.subscriptions.get(vk);
    if (!sub || !sub.incentive) return undefined;
    // Only match our specific incentive output, not any output with this verifier.
    if (
      !Hash.equals(sub.incentive.blockHash, target.block) ||
      sub.incentive.outputIndex !== target.outputIndex
    ) {
      return undefined;
    }
    return sub;
  }

  private _reevaluate(sub: Subscription): void {
    // Pick the first canonical claimant.
    //
    // NOTE (Phase 4): Trust gating is designed to be the surfacing gate
    // (see docs/design/trust-gate.md, docs/design/fetch.md). In practice,
    // local verification on response blocks currently fails on any node
    // that doesn't have a direct anchor path to the incentive (the
    // `collectExtendedOutputs` helper does not walk aggregate subtrees,
    // so claim indices referring to aggregated outputs resolve to the
    // wrong slot, and HELLO-style contracts reject with "no more inputs
    // available"). Until that gap is fixed, fetch surfaces on canonicality
    // alone for non-verify:true callers. The trust-gate wiring is left
    // in place (via `verify: true`) for callers who explicitly opt in.
    // See TODO.md for the verification-layer follow-up.
    let pickedHex: string | null = null;
    for (const [claimantHex] of sub.knownClaimants) {
      const claimantHash = Hash.fromHex(claimantHex);
      if (!this.deps.consensus.isCanonical(claimantHash)) continue;
      pickedHex = claimantHex;
      break;
    }

    if (pickedHex === null) {
      // Nothing canonical+trusted. If we had a previous surfacing, it was
      // invalidated with no replacement.
      if (sub.currentClaimant !== null) {
        sub.currentClaimant = null;
        for (const p of sub.projections) {
          this._invalidateProjection(p);
        }
      }
      return;
    }

    const picked = Hash.fromHex(pickedHex);
    const claimIdx = sub.knownClaimants.get(pickedHex)!;
    const pickedChanged = sub.currentClaimant === null ||
      !Hash.equals(sub.currentClaimant, picked);
    sub.currentClaimant = picked;

    const block = this.deps.blockStore.get(picked);
    if (!block) return;

    for (const p of sub.projections) {
      this._deliver(sub, p, block, claimIdx, pickedChanged);
    }
  }

  /** Drive a single projection from the subscription's current claim. */
  private _refreshProjection(sub: Subscription, p: Projection): void {
    if (!sub.currentClaimant) return;
    const block = this.deps.blockStore.get(sub.currentClaimant);
    if (!block) return;
    const claimIdx = sub.knownClaimants.get(sub.currentClaimant.toHex());
    if (claimIdx === undefined) return;
    this._deliver(sub, p, block, claimIdx, true);
  }

  private _deliver(
    sub: Subscription,
    p: Projection,
    block: Block,
    claimIdx: number,
    pickedChanged: boolean,
  ): void {
    const recordOutput = findRecordOutput(block, p.recordKey);
    if (!recordOutput) {
      // Responder didn't produce a record for this key. Only notify via
      // onError if we haven't already; treat as exceptional.
      if (p.currentBlockHash === undefined || !Hash.equals(p.currentBlockHash, block.hash)) {
        p.onError?.(new Error(`responder block has no record for requested key`));
      }
      return;
    }
    const newData = recordOutput.data;

    // verify:true path: gate on local verification.
    if (p.verify) {
      // If already settled (previous verify accepted), don't resolve again.
      if (p.promise?.settled) return;
      this.deps.blockVerification.verify(block.hash).then((result) => {
        if (!p.promise || p.promise.settled) return;
        if (result.accepted) {
          const claim = this._buildClaim(sub, block, claimIdx, newData);
          p.currentClaim = claim;
          p.currentData = newData;
          p.currentBlockHash = block.hash;
          p.promise.settled = true;
          p.promise.resolve(claim);
        } else {
          // Reject this candidate; keep waiting for the next canonical
          // claimant. Surface via onError for diagnosis.
          p.onError?.(new VerificationRejectedError(result.reason));
        }
      });
      return;
    }

    // Streaming path.
    const sameBlock = p.currentBlockHash && Hash.equals(p.currentBlockHash, block.hash);
    const sameData = p.currentData && byteEquals(p.currentData, newData);

    if (sameBlock && sameData) return; // no-op

    const newClaim = this._buildClaim(sub, block, claimIdx, newData);

    // Data changed (or first delivery): supersede previous and fire both.
    if (!sameData) {
      if (p.currentClaim) {
        p.currentClaim._supersede(new SupersededError());
      }
      p.currentClaim = newClaim;
      p.currentData = newData;
      p.currentBlockHash = block.hash;
      p.onClaim?.(newClaim);
      p.onResult?.(newClaim);
      return;
    }

    // Data same, block changed: fire onClaim only (claim transfer).
    if (pickedChanged) {
      p.currentClaim = newClaim;
      p.currentBlockHash = block.hash;
      p.onClaim?.(newClaim);
    }
  }

  private _invalidateProjection(p: Projection): void {
    if (!p.currentClaim) return;
    p.currentClaim._supersede(new InvalidatedError());
    p.currentClaim = undefined;
    p.currentData = undefined;
    p.currentBlockHash = undefined;
    p.onClaim?.(null);
    p.onResult?.(null);
    if (p.promise && !p.promise.settled) {
      p.promise.settled = true;
      p.promise.reject(new InvalidatedError());
    }
  }

  private _buildClaim<T>(
    sub: Subscription,
    block: Block,
    claimIdx: number,
    data: Uint8Array,
  ): FetchClaimImpl<T> {
    const contract = sub.contract;
    const contractHost = this.deps.contractHost;
    return new FetchClaimImpl<T>(
      data,
      () => parseRecord<T>(contract, data, contractHost),
      block,
      claimIdx,
    );
  }

  // -- Close / cleanup ----------------------------------------------

  private _closeProjection(
    verifierKey: string,
    projection: Projection,
    opts: { reason?: Error } = {},
  ): void {
    const sub = this.subscriptions.get(verifierKey);
    if (!sub) return;
    const idx = sub.projections.indexOf(projection);
    if (idx < 0) return;
    sub.projections.splice(idx, 1);
    // Detach abort listener
    if (projection.signal && projection.abortHandler) {
      projection.signal.removeEventListener('abort', projection.abortHandler);
      projection.abortHandler = undefined;
    }
    // If verify:true and not yet settled, reject the promise.
    if (projection.promise && !projection.promise.settled) {
      projection.promise.settled = true;
      projection.promise.reject(opts.reason ?? new FetchAbortError());
    }
    // Supersede any outstanding parse promises.
    if (projection.currentClaim) {
      projection.currentClaim._supersede(opts.reason ?? new FetchAbortError());
    }
    // If no projections remain, drop the subscription entirely.
    if (sub.projections.length === 0) {
      this.subscriptions.delete(verifierKey);
      // Remove reverse index entries for this subscription.
      for (const claimantHex of sub.knownClaimants.keys()) {
        const set = this.claimantToVerifiers.get(claimantHex);
        if (set) {
          set.delete(verifierKey);
          if (set.size === 0) this.claimantToVerifiers.delete(claimantHex);
        }
      }
    }
  }
}

// -- Helpers ---------------------------------------------------------

function encodeParams(
  contractHash: Hash,
  params: Uint8Array | Record<string, unknown>,
  contractHost: ContractHostService,
): Uint8Array {
  if (params instanceof Uint8Array) return params;
  const contract = contractHost.getContract(contractHash);
  if (!contract) {
    throw new Error(`contract not registered: ${contractHash.toHex()}`);
  }
  if (!contract.buildParams) {
    throw new Error(
      `contract ${contractHash.toHex()} does not support buildParams; ` +
        'pass params as Uint8Array',
    );
  }
  const values = flatten(params);
  const host = new DefaultBuilderHost(values);
  return contract.buildParams(host);
}

function normalizeRecordKey(key: string | Uint8Array | undefined): Uint8Array {
  if (key === undefined) return new Uint8Array(0);
  if (typeof key === 'string') return new TextEncoder().encode(key);
  return key;
}

function computeVerifierKey(contract: Hash, params: Uint8Array): string {
  return contract.toHex() + ':' + bin2hex(params);
}

function byteEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function flatten(
  obj: Record<string, unknown>,
  prefix = '',
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array) && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, key, out);
    } else if (Array.isArray(v)) {
      out.set(key, v.length);
      for (let i = 0; i < v.length; i++) {
        const el = v[i];
        const elKey = `${key}.${i}`;
        if (el !== null && typeof el === 'object' && !(el instanceof Uint8Array)) {
          flatten(el as Record<string, unknown>, elKey, out);
        } else {
          out.set(elKey, el);
        }
      }
    } else {
      out.set(key, v);
    }
  }
  return out;
}

/** Run contract.walkData on record bytes and return a JS object. */
async function parseRecord<T>(
  contract: Hash,
  data: Uint8Array,
  contractHost: ContractHostService,
): Promise<T> {
  const impl = contractHost.getContract(contract);
  if (!impl) {
    throw new Error(`contract not registered: ${contract.toHex()}`);
  }
  if (!impl.walkData) {
    throw new Error(
      `contract ${contract.toHex()} does not support walkData`,
    );
  }
  const host = new RecordingWalkerHost();
  await impl.walkData(data, host);
  return walkerTreeToObject(host.getTree()) as T;
}

function walkerTreeToObject(nodes: FieldNode[]): unknown {
  // Top level: if single unnamed node, return its value directly.
  if (nodes.length === 1 && nodes[0].key === '') {
    return fieldNodeValue(nodes[0]);
  }
  const out: Record<string, unknown> = {};
  for (const n of nodes) out[n.key] = fieldNodeValue(n);
  return out;
}

function fieldNodeValue(n: FieldNode): unknown {
  switch (n.kind) {
    case 'bytes':
      return n.value;
    case 'string':
    case 'number':
    case 'bool':
      return n.value;
    case 'map':
      return walkerTreeToObject(n.children);
    case 'list': {
      const arr: unknown[] = [];
      for (const c of n.children) arr.push(fieldNodeValue(c));
      return arr;
    }
  }
}

// -- Re-exports for external consumers -----------------------------

export type { Verifier };
export { SupersededError, InvalidatedError, VerificationRejectedError, NotImplementedError, FetchAbortError };
