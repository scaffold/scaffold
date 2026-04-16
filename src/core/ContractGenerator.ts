// Protocol spec: docs/protocol/computation.md

import { Hash, ZERO_HASH } from '../util/Hash.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import { Block, BlockStore, collectExtendedOutputs } from './Block.ts';
import { BlockDraft, ClaimIntent, DraftStore } from './BlockDraft.ts';
import { GeneratorHandle, GeneratorProvider } from './Generator.ts';
import {
  type AvailableInput,
  ContractRejection,
  type GeneratingEnvProvider,
} from './ContractEnv.ts';
import type { Contract } from '../contracts/Contract.ts';
import { GeneratingEnv, type WaitForInputFn } from './GeneratingEnv.ts';
import { OutputClaimModule } from './OutputClaimModule.ts';
import { UtxoIndex } from '../node/UtxoIndex.ts';
import type { MaybePromise } from '../util/MaybePromise.ts';
import { maybeThen } from '../util/MaybePromise.ts';

// -- GeneratingEnvAdapter -----------------------------------------

/**
 * Adapts BlockStore + UtxoIndex + OutputClaimModule into GeneratingEnvProvider.
 * Filters already-claimed outputs from findInputs results.
 */
class GeneratingEnvAdapter implements GeneratingEnvProvider<Block> {
  constructor(
    private readonly store: BlockStore,
    private readonly utxoIndex: UtxoIndex,
    private readonly outputClaims: OutputClaimModule<Block>,
  ) {}

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getOutputs(block: Block): Output[] {
    return block.outputs;
  }

  getClaims(block: Block): number[] {
    return block.claims;
  }

  getRefs(block: Block): Hash[] {
    return block.refs;
  }

  getExtendedOutputs(block: Block): Output[] {
    return collectExtendedOutputs(block, this.store);
  }

  findInputs(verifier: Verifier): AvailableInput[] {
    const entries = this.utxoIndex.getByVerifier(verifier.contract, verifier.params);
    const result: AvailableInput[] = [];

    for (const entry of entries) {
      // Filter out already-claimed outputs
      const claimants = this.outputClaims.getClaimantsAt(entry.blockHash, entry.outputIndex);
      if (claimants && claimants.length > 0) continue;

      // Look up the actual output for data
      const block = this.store.get(entry.blockHash);
      if (!block || entry.outputIndex >= block.outputs.length) continue;

      const output = block.outputs[entry.outputIndex];
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
    // Scan the store for a block that claims an output matching this verifier.
    // Claims at index >= ownOutputCount reference the anchor's extended output vector.
    for (const block of this.store.values()) {
      if (Hash.equals(block.anchor, ZERO_HASH)) continue;
      const anchorBlock = this.store.get(block.anchor);
      if (!anchorBlock) continue;

      const anchorExtended = collectExtendedOutputs(anchorBlock, this.store);
      const ownOutputCount = block.outputs.length;

      for (const claimIdx of block.claims) {
        if (claimIdx < ownOutputCount) continue; // self-claim
        const extIdx = claimIdx - ownOutputCount;
        if (extIdx >= anchorExtended.length) continue;

        const output = anchorExtended[extIdx];
        if (
          Hash.equals(output.verifier.contract, verifier.contract) &&
          bytesEqual(output.verifier.params, verifier.params)
        ) {
          return block.hash;
        }
      }
    }
    return undefined;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Key for the blocked-generator registry. */
function verifierKey(v: Verifier): string {
  return `${v.contract.toPrimitive()}:${Array.from(v.params).join(',')}`;
}

// -- Blocked generator entry --------------------------------------

interface BlockedGenerator {
  env: GeneratingEnv<Block>;
  draftId: Hash;
  resolve: (input: AvailableInput) => void;
}

// -- ContractGenerator -------------------------------------------

/**
 * Generator that runs contracts via GeneratingEnv to build block drafts.
 *
 * Given a draft with resolved claims identifying the contract to run,
 * it creates a GeneratingEnv, executes the contract, and populates the
 * draft with generated outputs, additional resolved claims, and refs.
 *
 * Supports blocking requireInput(): when a contract needs more inputs
 * than currently available, the generator blocks and is registered in
 * a waiting queue. When new outputs become available, blocked generators
 * are resumed before new drafts are created.
 */
export class ContractGenerator implements GeneratorProvider {
  private readonly _lookupContract: (hash: Hash) => Contract | undefined;
  private readonly _adapter: GeneratingEnvAdapter;
  private readonly _draftStore: DraftStore;
  private readonly _outputClaims: OutputClaimModule<Block>;

  /** Blocked generators waiting for inputs, keyed by verifier. */
  private readonly _blocked = new Map<string, BlockedGenerator[]>();

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

  generate(draft: BlockDraft): GeneratorHandle {
    let cancelled = false;

    // Find the contract to run from the draft's resolved claims.
    // The first resolved claim's output determines the contract.
    const claim = draft.resolvedClaims[0];
    if (!claim) {
      // No claims -- nothing to generate. Transition to ready immediately.
      this._draftStore.transition(draft.draftId, 'ready');
      return { draftId: draft.draftId, cancel: () => {} };
    }

    // Look up the output being claimed to find the contract
    const block = this._adapter.getBlock(claim.block);
    if (!block) {
      this._draftStore.transition(draft.draftId, 'cancelled');
      return { draftId: draft.draftId, cancel: () => {} };
    }

    const output = block.outputs[claim.outputIndex];
    if (!output) {
      this._draftStore.transition(draft.draftId, 'cancelled');
      return { draftId: draft.draftId, cancel: () => {} };
    }

    const contractHash = output.verifier.contract;
    const params = output.verifier.params;
    const contract = this._lookupContract(contractHash);
    if (!contract) {
      this._draftStore.transition(draft.draftId, 'cancelled');
      return { draftId: draft.draftId, cancel: () => {} };
    }

    // Create waitForInput callback that registers in our blocked queue
    const waitForInput: WaitForInputFn = (verifier: Verifier) => {
      return new Promise<AvailableInput>((resolve) => {
        const key = verifierKey(verifier);
        let queue = this._blocked.get(key);
        if (!queue) {
          queue = [];
          this._blocked.set(key, queue);
        }
        queue.push({ env, draftId: draft.draftId, resolve });
      });
    };

    const env = new GeneratingEnv<Block>({
      contractHash,
      params,
      provider: this._adapter,
      waitForInput,
    });

    // Run the contract (may be sync or async)
    const result = this._runContract(contract, env, draft, () => cancelled);
    if (result instanceof Promise) {
      result.catch(() => {
        // Errors handled inside _runContract
      });
    }

    return {
      draftId: draft.draftId,
      cancel: () => {
        cancelled = true;
        this._outputClaims.removeClaims(draft.draftId);
        this._removeBlocked(draft.draftId);
      },
    };
  }

  /**
   * Notify that a new unclaimed output is available. Checks if a blocked
   * generator is waiting for this verifier and resumes it.
   *
   * Returns true if a blocked generator was resumed (caller should not
   * create a new draft for this output).
   */
  notifyNewOutput(
    blockHash: Hash,
    outputIndex: number,
    output: Output,
  ): boolean {
    const key = verifierKey(output.verifier);
    const queue = this._blocked.get(key);
    if (!queue || queue.length === 0) return false;

    const entry = queue.shift()!;
    if (queue.length === 0) this._blocked.delete(key);

    // Pre-claim the output for the blocked generator's draft
    this._outputClaims.addClaim(entry.draftId, blockHash, outputIndex);

    // Resume the generator
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

  /** Check if any generators are blocked (for testing/introspection). */
  get blockedCount(): number {
    let count = 0;
    for (const queue of this._blocked.values()) {
      count += queue.length;
    }
    return count;
  }

  private _removeBlocked(draftId: Hash): void {
    for (const [key, queue] of this._blocked) {
      const filtered = queue.filter((e) => !Hash.equals(e.draftId, draftId));
      if (filtered.length === 0) {
        this._blocked.delete(key);
      } else {
        this._blocked.set(key, filtered);
      }
    }
  }

  private _runContract(
    contract: Contract,
    env: GeneratingEnv<Block>,
    draft: BlockDraft,
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
        if (!isCancelled()) {
          this._draftStore.transition(draft.draftId, 'cancelled');
        }
        return;
      }
      if (!isCancelled()) {
        this._draftStore.transition(draft.draftId, 'cancelled');
      }
      return;
    }
  }

  private _applyResults(env: GeneratingEnv<Block>, draft: BlockDraft): void {
    const newOutputs = env.getAllOutputs();
    const newClaims = env.getResolvedClaims();
    const newRefs = env.getGeneratedRefs();
    const newIncludes = env.getIncludeConstraints();

    // Register ALL consumed inputs as claims in the OutputClaimModule
    for (const claim of newClaims) {
      this._outputClaims.addClaim(draft.draftId, claim.block, claim.outputIndex);
    }

    // Deduplicate: drop claims the contract produced that already exist
    // on the draft (e.g. the trigger claim that requireInput() re-found).
    const existingClaimKeys = new Set(
      draft.resolvedClaims.map((rc) => `${rc.block.toPrimitive()}:${rc.outputIndex}`),
    );
    const dedupedClaims = newClaims.filter(
      (rc) => !existingClaimKeys.has(`${rc.block.toPrimitive()}:${rc.outputIndex}`),
    );

    // Deduplicate include constraints against existing ones
    const existingIncludes = new Set(
      draft.includeConstraints.map((h) => h.toPrimitive()),
    );
    const dedupedIncludes = newIncludes.filter(
      (h) => !existingIncludes.has(h.toPrimitive()),
    );

    // Merge generation results into the draft
    this._draftStore.update(draft.draftId, {
      outputs: [...draft.outputs, ...newOutputs],
      resolvedClaims: [...draft.resolvedClaims, ...dedupedClaims],
      refs: [...draft.refs, ...newRefs],
      includeConstraints: [...draft.includeConstraints, ...dedupedIncludes],
    });

    // Transition to ready
    this._draftStore.transition(draft.draftId, 'ready');
  }
}
