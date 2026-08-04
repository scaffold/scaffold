// Design spec: docs/design/piggyback.md (universal piggyback variant)
//
// PiggybackStrategy: for every {canonical unspent output O with verifier V,
// trusted block B that already serves V but does not claim O}, construct
// our own claiming block referencing B, locally verify it, and on accept
// publish it to compete for O.
//
// The strategy is decoupled from FetchManager -- piggyback runs on every
// canonical UTXO, not just incentives we ourselves posted. The node
// becomes a competitive responder on every verifier it can serve.
//
// Trigger sources (all funnel into _attemptPiggyback):
//   1. New canonical block whose trust gate already says "trusted"
//      (handled in evaluate() via canonicalityChanges).
//   2. Trust transition: a previously untrusted block becomes trusted
//      (handled via TrustGate.onTrustChanged + dispatchActions).
//   3. New unspent canonical UTXO appears for a verifier we already have a
//      trusted source for (handled via UtxoIndex.onOutputReAdded).
// Plus a follow-up subscription on BlockVerification.onStatusChanged that
// graduates a locally-verified piggyback to broadcast via submitBlock.

import { Hash, HashPrimitive } from '../../util/Hash.ts';
import { Block, BlockStore, RECORD_CONTRACT, SIGNATURE_CONTRACT } from '../../core/Block.ts';
import { BlockSpec, ClaimEntry, Output } from '../../core/BlockCreationModule.ts';
import { OutputSpaceModule } from '../../core/OutputSpace.ts';
import { ScopedLogger } from '../../logic/EventLog.ts';
import { Action, ReactiveEvent, Strategy } from '../ReactiveLayer.ts';
import { TrustStatus } from '../TrustGate.ts';
import { UtxoEntry, verifierKey } from '../UtxoIndex.ts';

// -- Provider interfaces (minimal slices for testability) -------------

export interface PiggybackTrustGate {
  status(hash: Hash): TrustStatus;
  onTrustChanged(cb: (hash: Hash, status: TrustStatus) => void): () => void;
}

export interface PiggybackBlockVerification {
  verify(hash: Hash): Promise<{ accepted: boolean; reason?: string }>;
  onStatusChanged(
    cb: (hash: Hash, status: 'unknown' | 'verifying' | 'passed' | 'failed') => void,
  ): () => void;
}

export interface PiggybackUtxoIndex {
  getByVerifier(contract: Hash, params: Uint8Array): UtxoEntry[];
  onOutputReAdded(cb: (blockHash: Hash, outputIndex: number) => void): void;
}

export interface PiggybackOutputClaims {
  onResolution(
    cb: (claimant: Hash, target: { block: Hash; outputIndex: number }) => void,
  ): void;
}

export interface PiggybackConsensus {
  isCanonical(hash: Hash): boolean;
  getCanonicalView(): ReadonlySet<HashPrimitive>;
}

export interface PiggybackDispatcher {
  dispatchActions(actions: Action[]): void;
}

export interface PiggybackDeps {
  trustGate: PiggybackTrustGate;
  blockVerification: PiggybackBlockVerification;
  blockStore: BlockStore;
  consensus: PiggybackConsensus;
  utxoIndex: PiggybackUtxoIndex;
  outputClaims: PiggybackOutputClaims;
  dispatcher: PiggybackDispatcher;
  outputSpace: () => OutputSpaceModule;
  logger?: ScopedLogger;
}

// -- Strategy ---------------------------------------------------------

export class PiggybackStrategy implements Strategy {
  private readonly deps: PiggybackDeps;

  /** verifierKey -> set of source-block hex hashes that serve V. */
  private readonly trustedSourcesByVerifier = new Map<string, Set<string>>();

  /** Reverse map: source hex -> set of verifierKeys, for eviction. */
  private readonly sourceVerifiers = new Map<string, Set<string>>();

  /** Per-claimant accumulated resolutions (mirrors BlockVerificationModule). */
  private readonly resolvedClaimsByClaimant = new Map<
    string,
    { block: Hash; outputIndex: number }[]
  >();

  /** Dedup attempts. Key = "vKey|sourceHex|targetHex:outputIdx". */
  private readonly attempted = new Set<string>();

  /** Pending piggyback blocks awaiting verification. */
  private readonly pending = new Map<
    string,
    {
      source: Hash;
      verifier: string;
      candidate: { block: Hash; outputIndex: number };
      attemptKey: string;
    }
  >();

  constructor(deps: PiggybackDeps) {
    this.deps = deps;

    deps.outputClaims.onResolution((claimant, target) => {
      this._recordResolution(claimant, target);
      // If this claimant is already trusted, the new resolution may
      // unlock additional V -> B mappings.
      const status = deps.trustGate.status(claimant);
      if (status.kind === 'trusted') {
        const actions: Action[] = [];
        this._collectActionsForBlock(claimant, actions);
        if (actions.length > 0) deps.dispatcher.dispatchActions(actions);
      }
    });

    deps.trustGate.onTrustChanged((hash, status) => {
      if (status.kind === 'trusted') {
        const actions: Action[] = [];
        this._collectActionsForBlock(hash, actions);
        if (actions.length > 0) deps.dispatcher.dispatchActions(actions);
      } else {
        this._evictSource(hash);
      }
    });

    deps.utxoIndex.onOutputReAdded((blockHash, outputIndex) => {
      this._onUtxoAdded(blockHash, outputIndex);
    });

    deps.blockVerification.onStatusChanged((hash, status) => {
      this._onVerificationChanged(hash, status);
    });
  }

  evaluate(event: ReactiveEvent): Action[] {
    const actions: Action[] = [];
    for (const change of event.result.canonicalityChanges) {
      if (!change.canonical) continue;
      const status = this.deps.trustGate.status(change.hash);
      if (status.kind !== 'trusted') continue;
      this._collectActionsForBlock(change.hash, actions);
    }
    return actions;
  }

  // -- Internals ------------------------------------------------------

  private _recordResolution(
    claimant: Hash,
    target: { block: Hash; outputIndex: number },
  ): void {
    const key = claimant.toHex();
    let list = this.resolvedClaimsByClaimant.get(key);
    if (!list) {
      list = [];
      this.resolvedClaimsByClaimant.set(key, list);
    }
    if (
      !list.some((r) => Hash.equals(r.block, target.block) && r.outputIndex === target.outputIndex)
    ) {
      list.push(target);
    }
  }

  /**
   * Walk the source block's resolved claims. For each verifier V it
   * serves, record B in the inverted index, then enumerate canonical
   * unspent UTXOs for V and emit a piggyback createBlock action for each
   * one B does not already claim.
   */
  private _collectActionsForBlock(sourceHash: Hash, actions: Action[]): void {
    const sourceBlock = this.deps.blockStore.get(sourceHash);
    if (!sourceBlock) return;
    const claims = this.resolvedClaimsByClaimant.get(sourceHash.toHex()) ?? [];
    if (claims.length === 0) return;

    // Pre-compute the source's RECORD outputs once (shared across all
    // (V, sourceHash, O) attempts derived from this scan).
    const recordOutputs = this._extractRecordOutputs(sourceBlock);
    if (recordOutputs.length === 0) {
      // Source serves V but produces no record output -- nothing for
      // a downstream verifier to read via our copy. Skip.
      return;
    }

    const sourceHex = sourceHash.toHex();
    for (const claim of claims) {
      const targetBlock = this.deps.blockStore.get(claim.block);
      if (!targetBlock) continue;
      const claimedOutput = targetBlock.outputs[claim.outputIndex];
      if (!claimedOutput) continue;
      // Skip trivial / structural verifiers. SIGNATURE outputs are
      // payment outputs; piggybacking them would mean trying to claim
      // arbitrary signature UTXOs we don't own. Same exclusion as
      // DraftStrategy's default `enableGeneration`.
      if (Hash.equals(claimedOutput.verifier.contract, SIGNATURE_CONTRACT)) {
        continue;
      }

      const vKey = verifierKey(
        claimedOutput.verifier.contract,
        claimedOutput.verifier.params,
      );

      // Update the inverted index.
      let sources = this.trustedSourcesByVerifier.get(vKey);
      if (!sources) {
        sources = new Set();
        this.trustedSourcesByVerifier.set(vKey, sources);
      }
      sources.add(sourceHex);
      let verifiersOfSource = this.sourceVerifiers.get(sourceHex);
      if (!verifiersOfSource) {
        verifiersOfSource = new Set();
        this.sourceVerifiers.set(sourceHex, verifiersOfSource);
      }
      verifiersOfSource.add(vKey);

      // Find unspent canonical UTXOs for this verifier other than the
      // one source already claims.
      const utxos = this.deps.utxoIndex.getByVerifier(
        claimedOutput.verifier.contract,
        claimedOutput.verifier.params,
      );
      for (const utxo of utxos) {
        if (
          Hash.equals(utxo.blockHash, claim.block) &&
          utxo.outputIndex === claim.outputIndex
        ) {
          continue; // source already claims this one
        }
        this._tryEmitPiggyback(vKey, sourceBlock, recordOutputs, utxo, actions);
      }
    }
  }

  private _onUtxoAdded(blockHash: Hash, outputIndex: number): void {
    const block = this.deps.blockStore.get(blockHash);
    if (!block) return;
    const output = block.outputs[outputIndex];
    if (!output) return;
    if (Hash.equals(output.verifier.contract, SIGNATURE_CONTRACT)) return;

    const vKey = verifierKey(output.verifier.contract, output.verifier.params);
    const sources = this.trustedSourcesByVerifier.get(vKey);
    if (!sources || sources.size === 0) return;

    const utxo: UtxoEntry = {
      blockHash,
      outputIndex,
      value: output.value,
      extendedIndex: outputIndex,
    };

    const actions: Action[] = [];
    for (const sourceHex of sources) {
      const sourceBlock = this._getBlockByHex(sourceHex);
      if (!sourceBlock) continue;
      const recordOutputs = this._extractRecordOutputs(sourceBlock);
      if (recordOutputs.length === 0) continue;
      this._tryEmitPiggyback(vKey, sourceBlock, recordOutputs, utxo, actions);
    }
    if (actions.length > 0) this.deps.dispatcher.dispatchActions(actions);
  }

  private _evictSource(hash: Hash): void {
    const hashHex = hash.toHex();
    const verifiers = this.sourceVerifiers.get(hashHex);
    if (!verifiers) return;
    for (const vKey of verifiers) {
      const set = this.trustedSourcesByVerifier.get(vKey);
      if (set) {
        set.delete(hashHex);
        if (set.size === 0) this.trustedSourcesByVerifier.delete(vKey);
      }
    }
    this.sourceVerifiers.delete(hashHex);
  }

  private _onVerificationChanged(
    hash: Hash,
    status: 'unknown' | 'verifying' | 'passed' | 'failed',
  ): void {
    if (status !== 'passed' && status !== 'failed') return;
    const key = hash.toHex();
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    if (status === 'failed') {
      this.deps.logger?.warn('piggybackRejected', {
        hash: key,
        source: entry.source.toHex(),
        verifier: entry.verifier,
      });
      // Reopen the attempt slot so a future trigger can retry with a
      // different source for the same UTXO.
      this.attempted.delete(entry.attemptKey);
      return;
    }
    this.deps.logger?.info('piggybackPublished', { hash: key });
    this.deps.dispatcher.dispatchActions([{ type: 'submitBlock', hash }]);
  }

  private _tryEmitPiggyback(
    vKey: string,
    sourceBlock: Block,
    recordOutputs: Output[],
    utxo: UtxoEntry,
    actions: Action[],
  ): void {
    const sourceHash = sourceBlock.hash;
    const attemptKey =
      `${vKey}|${sourceHash.toHex()}|${utxo.blockHash.toHex()}:${utxo.outputIndex}`;
    if (this.attempted.has(attemptKey)) return;

    const anchor = findCanonicalTip(this.deps.blockStore, this.deps.consensus);
    if (!anchor) return;

    const outputSpace = this.deps.outputSpace();
    const postSubtreeIdx = outputSpace.computeOutputSpaceIndex(anchor, {
      block: utxo.blockHash,
      outputIndex: utxo.outputIndex,
    });
    if (postSubtreeIdx === undefined) {
      // Not reachable from the current canonical tip. Don't mark
      // attempted -- a later trigger can retry once the anchor catches
      // up. Should be rare: canonical UTXOs against canonical tips are
      // always reachable, but a transient race during a tip flip can
      // leave a UTXO momentarily unindexed against the new anchor.
      this.deps.logger?.debug('piggybackAnchorUnreachable', {
        verifier: vKey,
        source: sourceHash.toHex(),
        candidate: utxo.blockHash.toHex(),
      });
      return;
    }

    // Mark as attempted BEFORE emitting so a synchronous re-entry from
    // dispatch does not double-emit.
    this.attempted.add(attemptKey);

    const finalOwnCount = recordOutputs.length;
    const selfClaims: ClaimEntry[] = [];
    for (let i = 0; i < recordOutputs.length; i++) {
      selfClaims.push({ index: i, value: recordOutputs[i].value });
    }
    const incentiveClaim: ClaimEntry = {
      index: finalOwnCount + postSubtreeIdx,
      value: utxo.value,
    };

    const spec: BlockSpec = {
      anchor,
      outputs: recordOutputs,
      claims: [...selfClaims, incentiveClaim],
      declaredWeight: 0,
      aggregates: [],
      refs: [sourceHash],
    };

    const candidate = { block: utxo.blockHash, outputIndex: utxo.outputIndex };

    actions.push({
      type: 'createBlock',
      spec,
      sign: true,
      broadcast: false,
      onCreated: (block) => {
        if (!block) {
          // Build failed -- reopen the attempt slot.
          this.attempted.delete(attemptKey);
          this.deps.logger?.debug('piggybackBuildFailed', {
            verifier: vKey,
            source: sourceHash.toHex(),
            candidate: candidate.block.toHex(),
          });
          return;
        }
        this.pending.set(block.hash.toHex(), {
          source: sourceHash,
          verifier: vKey,
          candidate,
          attemptKey,
        });
        this.deps.logger?.info('piggybackBuilt', {
          hash: block.hash.toHex(),
          source: sourceHash.toHex(),
          verifier: vKey,
          candidate: `${candidate.block.toHex()}:${candidate.outputIndex}`,
        });
        // Force verification: sampling may not pick up a
        // self-authored block and we want a deterministic gate before
        // graduating to broadcast.
        this.deps.blockVerification.verify(block.hash).catch(() => {
          /* swallow -- onStatusChanged drives our state machine. */
        });
      },
    });
  }

  /** Self-claimed RECORD outputs of the source block, copied verbatim. */
  private _extractRecordOutputs(sourceBlock: Block): Output[] {
    const ownOutputCount = sourceBlock.outputs.length;
    const selfClaims = new Set(
      sourceBlock.claimIndices.filter((c) => c < ownOutputCount),
    );
    const out: Output[] = [];
    for (let i = 0; i < sourceBlock.outputs.length; i++) {
      if (!selfClaims.has(i)) continue;
      const o = sourceBlock.outputs[i];
      if (!Hash.equals(o.verifier.contract, RECORD_CONTRACT)) continue;
      out.push({
        verifier: { contract: o.verifier.contract, params: o.verifier.params },
        value: o.value,
        body: o.body,
      });
    }
    return out;
  }

  private _getBlockByHex(hex: string): Block | undefined {
    for (const b of this.deps.blockStore.values()) {
      if (b.hash.toHex() === hex) return b;
    }
    return undefined;
  }
}

/** Find the deepest canonical block. Mirrors DraftStrategy's local helper. */
function findCanonicalTip(
  store: BlockStore,
  consensus: PiggybackConsensus,
): Hash | undefined {
  const canonical = consensus.getCanonicalView();
  let bestHash: Hash | undefined;
  let bestDepth = -1;

  for (const key of canonical) {
    const hash = Hash.fromPrimitive(key);
    const block = store.get(hash);
    if (!block) continue;

    let depth = 0;
    let cur = block.anchor;
    while (store.has(cur)) {
      depth++;
      const parent = store.get(cur);
      if (!parent) break;
      cur = parent.anchor;
    }

    if (depth > bestDepth) {
      bestDepth = depth;
      bestHash = hash;
    }
  }

  if (bestHash) return bestHash;
  const it = canonical[Symbol.iterator]().next();
  if (it.done) return undefined;
  return Hash.fromPrimitive(it.value);
}
