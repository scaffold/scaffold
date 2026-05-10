// Test-only compat shim for the former `ContractGenerator`.
//
// The production path is now `GenerationService` (wired through DI), which
// does contract dispatch plus draft lifecycle plus canonicality-driven
// restart. Older generation-only tests want a simpler "run the contract,
// write results onto the draft" primitive; this shim provides that.

import { Hash, ZERO_HASH } from '../../src/util/Hash.ts';
import type { Output, Verifier } from '../../src/core/BlockCreationModule.ts';
import {
  Block,
  BlockStore,
  makeBlockStoreOutputSpace,
  resolveClaimToOutput,
} from '../../src/core/Block.ts';
import type { OutputSpaceModule } from '../../src/core/OutputSpace.ts';
import { Draft, DraftStore } from '../../src/core/Draft.ts';
import type { ClaimRef } from '../../src/core/Node.ts';
import { OutputClaimModule } from '../../src/core/OutputClaimModule.ts';
import { UtxoIndex } from '../../src/node/UtxoIndex.ts';
import {
  type AvailableInput,
  ContractRejection,
  type GeneratingEnvProvider,
} from '../../src/core/ContractEnv.ts';
import type { Contract } from '../../src/contracts/Contract.ts';
import { GeneratingEnv, type WaitForInputFn } from '../../src/core/GeneratingEnv.ts';
import type { MaybePromise } from '../../src/util/MaybePromise.ts';
import { maybeThen } from '../../src/util/MaybePromise.ts';

class GeneratingEnvAdapter implements GeneratingEnvProvider<Block> {
  private readonly outputSpace: OutputSpaceModule;

  constructor(
    private readonly store: BlockStore,
    private readonly utxoIndex: UtxoIndex,
    private readonly outputClaims: OutputClaimModule<Block>,
  ) {
    this.outputSpace = makeBlockStoreOutputSpace(store);
  }
  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }
  getOutputs(block: Block): Output[] {
    return block.outputs;
  }
  getClaims(block: Block): number[] {
    return block.claimIndices;
  }
  getRefs(block: Block): Hash[] {
    return block.refs;
  }
  resolveClaim(block: Block, claimIndex: number): Output | undefined {
    return resolveClaimToOutput(block, claimIndex, this.store, this.outputSpace)?.output;
  }
  findInputs(verifier: Verifier): AvailableInput[] {
    const entries = this.utxoIndex.getByVerifier(verifier.contract, verifier.params);
    const result: AvailableInput[] = [];
    for (const entry of entries) {
      const claimants = this.outputClaims.getClaimantsAt(entry.blockHash, entry.outputIndex);
      if (claimants && claimants.length > 0) continue;
      const block = this.store.get(entry.blockHash);
      if (!block || entry.outputIndex >= block.outputs.length) continue;
      const output = block.outputs[entry.outputIndex];
      // Data-less outputs are pure-incentive and invisible to contracts.
      if (output.data === undefined) continue;
      result.push({
        verifier: output.verifier,
        value: output.value,
        data: output.data,
        isSelfClaim: false,
        block: entry.blockHash,
        outputIndex: entry.outputIndex,
      });
    }
    return result;
  }
  findBlockClaiming(verifier: Verifier): Hash | undefined {
    for (const block of this.store.values()) {
      if (Hash.equals(block.anchor, ZERO_HASH)) continue;
      const ownOutputCount = block.outputs.length;
      for (const claimIdx of block.claimIndices) {
        if (claimIdx < ownOutputCount) continue;
        const resolved = resolveClaimToOutput(block, claimIdx, this.store, this.outputSpace);
        if (!resolved) continue;
        if (
          Hash.equals(resolved.output.verifier.contract, verifier.contract) &&
          bytesEqual(resolved.output.verifier.params, verifier.params)
        ) return block.hash;
      }
    }
    return undefined;
  }
  resolveGetOutput(
    _runningContract: Hash,
    _runningParams: Uint8Array,
    _outputVerifier: Verifier,
  ): Promise<{ value: number; data: Uint8Array } | null> {
    // Test shim: no handlers registered, never resolves. Tests that
    // exercise requestBody should use the real OutputHandlerRegistry.
    return Promise.resolve(null);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function verifierKey(v: Verifier): string {
  return `${v.contract.toPrimitive()}:${Array.from(v.params).join(',')}`;
}

interface BlockedEntry {
  env: GeneratingEnv<Block>;
  draftId: Hash;
  resolve: (input: AvailableInput) => void;
}

export interface GeneratorHandle {
  draftId: Hash;
  cancel(): void;
}

/**
 * Direct-generation shim: the old ContractGenerator's `generate(draft)`
 * kept intact, restructured to use ContractHost's Env types and no DI.
 * Used only by a few generation-focused tests.
 */
export class ContractGeneratorShim {
  private readonly _lookupContract: (hash: Hash) => Contract | undefined;
  private readonly _adapter: GeneratingEnvAdapter;
  private readonly _draftStore: DraftStore;
  private readonly _outputClaims: OutputClaimModule<Block>;
  private readonly _blocked = new Map<string, BlockedEntry[]>();

  constructor(opts: {
    lookupContract: (hash: Hash) => Contract | undefined;
    store: BlockStore;
    utxoIndex: UtxoIndex;
    outputClaims: OutputClaimModule<Block>;
    draftStore: DraftStore;
  }) {
    this._lookupContract = opts.lookupContract;
    this._adapter = new GeneratingEnvAdapter(opts.store, opts.utxoIndex, opts.outputClaims);
    this._draftStore = opts.draftStore;
    this._outputClaims = opts.outputClaims;
  }

  generate(draft: Draft): GeneratorHandle {
    let cancelled = false;
    const claim = draft.claims[0];
    if (!claim) {
      this._draftStore.transition(draft.draftId, { phase: 'readyToSolidify' });
      return { draftId: draft.draftId, cancel: () => {} };
    }
    const block = this._adapter.getBlock(claim.producer);
    if (!block) {
      this._draftStore.transition(draft.draftId, { phase: 'failed', reason: 'cancelled', at: 'cancelled' });
      return { draftId: draft.draftId, cancel: () => {} };
    }
    const output = block.outputs[claim.outputIndex];
    if (!output) {
      this._draftStore.transition(draft.draftId, { phase: 'failed', reason: 'cancelled', at: 'cancelled' });
      return { draftId: draft.draftId, cancel: () => {} };
    }
    const verifier = output.verifier;
    const contract = this._lookupContract(verifier.contract);
    if (!contract) {
      this._draftStore.transition(draft.draftId, { phase: 'failed', reason: 'cancelled', at: 'cancelled' });
      return { draftId: draft.draftId, cancel: () => {} };
    }

    const waitForInput: WaitForInputFn = (v) =>
      new Promise<AvailableInput>((resolve) => {
        const key = verifierKey(v);
        let queue = this._blocked.get(key);
        if (!queue) {
          queue = [];
          this._blocked.set(key, queue);
        }
        queue.push({ env, draftId: draft.draftId, resolve });
      });

    const env = new GeneratingEnv<Block>({
      contractHash: verifier.contract,
      params: verifier.params,
      provider: this._adapter,
      waitForInput,
    });

    const result = this._runContract(contract, env, draft, () => cancelled);
    if (result instanceof Promise) result.catch(() => {});
    return {
      draftId: draft.draftId,
      cancel: () => {
        cancelled = true;
        this._outputClaims.removeClaims(draft.draftId);
        this._removeBlocked(draft.draftId);
      },
    };
  }

  notifyNewOutput(blockHash: Hash, outputIndex: number, output: Output): boolean {
    if (output.data === undefined) return false; // invisible to contracts
    const key = verifierKey(output.verifier);
    const queue = this._blocked.get(key);
    if (!queue || queue.length === 0) return false;
    const entry = queue.shift()!;
    if (queue.length === 0) this._blocked.delete(key);
    this._outputClaims.addClaim(entry.draftId, blockHash, outputIndex);
    entry.resolve({
      verifier: output.verifier,
      value: output.value,
      data: output.data,
      isSelfClaim: false,
      block: blockHash,
      outputIndex,
    });
    return true;
  }

  get blockedCount(): number {
    let c = 0;
    for (const q of this._blocked.values()) c += q.length;
    return c;
  }

  private _removeBlocked(draftId: Hash): void {
    for (const [key, queue] of this._blocked) {
      const filtered = queue.filter((e) => !Hash.equals(e.draftId, draftId));
      if (filtered.length === 0) this._blocked.delete(key);
      else this._blocked.set(key, filtered);
    }
  }

  private _runContract(
    contract: Contract,
    env: GeneratingEnv<Block>,
    draft: Draft,
    isCancelled: () => boolean,
  ): MaybePromise<void> {
    try {
      const result = contract.run(env);
      return maybeThen(result, () => {
        if (isCancelled()) return;
        this._applyResults(env, draft);
      });
    } catch (e) {
      if (e instanceof ContractRejection) {
        if (!isCancelled()) this._draftStore.transition(draft.draftId, { phase: 'failed', reason: 'cancelled', at: 'cancelled' });
        return;
      }
      if (!isCancelled()) this._draftStore.transition(draft.draftId, { phase: 'failed', reason: 'cancelled', at: 'cancelled' });
      return;
    }
  }

  private _applyResults(env: GeneratingEnv<Block>, draft: Draft): void {
    const newOutputs = env.getAllOutputs();
    const newClaims = env.getClaims();
    const newRefs = env.getGeneratedRefs();
    for (const c of newClaims) {
      this._outputClaims.addClaim(draft.draftId, c.producer, c.outputIndex);
    }
    const existingClaimKeys = new Set(
      draft.claims.map((c) => `${c.producer.toPrimitive()}:${c.outputIndex}`),
    );
    const dedupedClaimRefs: ClaimRef[] = newClaims
      .filter((c) => !existingClaimKeys.has(`${c.producer.toPrimitive()}:${c.outputIndex}`));
    this._draftStore.update(draft.draftId, {
      outputs: [...draft.outputs, ...newOutputs],
      claims: [...draft.claims, ...dedupedClaimRefs],
      refs: [...draft.refs, ...newRefs],
    });
    this._draftStore.transition(draft.draftId, { phase: 'readyToSolidify' });
  }
}
