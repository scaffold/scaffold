// Auto-balance: throughput-balancing of BlockSpecs.
//
// Today: queries UtxoIndex for owned signature outputs to cover any
// (output total - claim total) deficit. Surplus claims emit a change
// output. Step 8 of the consolidation refactor will switch the source
// from the UTXO index to the DraftManager pool of ready/solidifying
// drafts; until then this module is the single home for the autoBalance
// logic so callers (NodeContext._blockCreator, BlockBuilderModule)
// share one implementation.

import { BlockSpec, Verifier } from '../core/BlockCreationModule.ts';
import { BlockStore, SIGNATURE_CONTRACT } from '../core/Block.ts';
import { makeSignatureOutput } from '../contracts/SignatureContract.ts';
import { OutputSpaceModule } from '../core/OutputSpace.ts';
import { UtxoIndexService } from './UtxoIndexService.ts';
import { Hash } from '../util/Hash.ts';

export interface AutoBalanceLogger {
  warn?: (event: string, body?: Record<string, unknown>) => void;
}

/**
 * True iff any of the block's claims resolves to a verifier whose
 * contract declares SIGNATURE_CONTRACT in its outputNamespaces. Walks
 * the anchor's extended vector to resolve external claim indices; own-
 * output claims (index < ownOutputCount) are resolved directly from
 * `spec.outputs`.
 *
 * Aggregation blocks and complex cases where claims resolve deeper than
 * the anchor's own outputs return false (autoBalance proceeds normally)
 * -- the partition check at verification time catches any actual
 * violation.
 */
export function ownsSignatureNamespace(
  spec: BlockSpec,
  store: BlockStore,
  outputSpace: OutputSpaceModule,
  getOutputNamespaces: (contractHash: Hash) => Hash[],
): boolean {
  const ownOutputCount = spec.outputs.length;

  for (const claim of spec.claims) {
    let claimedVerifier: Verifier | undefined;
    if (claim.index < ownOutputCount) {
      claimedVerifier = spec.outputs[claim.index]?.verifier;
    } else {
      const extIdx = claim.index - ownOutputCount;
      const target = outputSpace.resolveOutputSpaceIndex(spec.anchor, extIdx);
      if (target) {
        const producer = store.get(target.block);
        claimedVerifier = producer?.outputs[target.outputIndex]?.verifier;
      }
    }
    if (!claimedVerifier) continue;
    const namespaces = getOutputNamespaces(claimedVerifier.contract);
    if (namespaces.some((h) => Hash.equals(h, SIGNATURE_CONTRACT))) {
      return true;
    }
  }
  return false;
}

/**
 * Auto-balance a BlockSpec so that throughput (inputs == outputs) is
 * satisfied.
 *
 * If outputs > claims (deficit): query UTXO index for unspent outputs
 * owned by our key, greedily select enough to cover the deficit, add a
 * change output for any excess, and emit claim indices resolved against
 * the anchor's extended vector via OutputSpaceModule.
 *
 * If claims > outputs: add a change output for the excess and shift
 * pre-existing external claim indices by one (adding an own output
 * moves the own/external boundary forward).
 */
export function autoBalance(
  spec: BlockSpec,
  utxoIndex: UtxoIndexService,
  publicKey: Uint8Array,
  outputSpace: OutputSpaceModule,
  store: BlockStore,
  getOutputNamespaces: (contractHash: Hash) => Hash[],
  logger: AutoBalanceLogger | undefined,
): BlockSpec {
  if (ownsSignatureNamespace(spec, store, outputSpace, getOutputNamespaces)) {
    logger?.warn?.('skipChangeOutput', {
      reason: 'SIGNATURE_CONTRACT namespace owned by claimed verifier',
    });
    return spec;
  }

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
    const deficit = outputTotal - claimTotal;
    const utxos = utxoIndex.getByVerifier(SIGNATURE_CONTRACT, publicKey);

    // Phase 1: Select UTXOs. Resolve each candidate's position in the
    // anchor's POST-SUBTREE vector (the survivors after the anchor's
    // own claims), not the anchor's full extended vector.
    const selected: { postSubtreeIdx: number; value: number }[] = [];
    let gathered = 0;
    for (const utxo of utxos) {
      if (gathered >= deficit) break;
      const postSubtreeIdx = outputSpace.computeOutputSpaceIndex(spec.anchor, {
        block: utxo.blockHash,
        outputIndex: utxo.outputIndex,
      });
      if (postSubtreeIdx === undefined) continue;
      selected.push({ postSubtreeIdx, value: utxo.value });
      gathered += utxo.value;
    }

    if (gathered < deficit) {
      // Not enough reachable funds -- proceed anyway and let validation catch it.
      return spec;
    }

    // Phase 2: Determine if change output needed.
    const excess = gathered - deficit;
    if (excess > 0) {
      newOutputs.push(makeSignatureOutput(publicKey, excess));
      // Shift existing external claim indices by 1 (adding an own
      // output moves the boundary).
      for (let i = 0; i < newClaims.length; i++) {
        if (newClaims[i].index >= ownOutputCount) {
          newClaims[i] = { ...newClaims[i], index: newClaims[i].index + 1 };
        }
      }
    }

    // Phase 3: Emit claim indices against the final own-output count.
    const finalOwnCount = newOutputs.length;
    for (const u of selected) {
      newClaims.push({ index: finalOwnCount + u.postSubtreeIdx, value: u.value });
    }
  } else {
    // Surplus claims: emit a change output for the excess.
    const excess = claimTotal - outputTotal;
    newOutputs.push(makeSignatureOutput(publicKey, excess));
    for (let i = 0; i < newClaims.length; i++) {
      if (newClaims[i].index >= ownOutputCount) {
        newClaims[i] = { ...newClaims[i], index: newClaims[i].index + 1 };
      }
    }
  }

  return { ...spec, outputs: newOutputs, claims: newClaims };
}
