import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore, getBlockClaimMask } from '../core/Block.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { SignedBlock, verifyBlockSignature } from './SignedBlock.ts';
import { decodeStatusData, statusHash } from './StatusContract.ts';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a signed block's authorization.
 *
 * Rules:
 * - Genesis (no anchor): always valid
 * - Blocks not claiming status outputs: always valid
 * - Blocks claiming status outputs: signature must match the publicKey in the claimed output data
 */
export function validateSignedBlock(sb: SignedBlock, store: BlockStore): ValidationResult {
  const block = sb.block;

  // Genesis is always valid
  if (Hash.equals(block.anchor, ZERO_HASH)) {
    return { ok: true };
  }

  // Find which outputs this block claims by resolving claim indices
  // against the anchor's extended output vector
  const anchorBlock = store.get(block.anchor);
  if (!anchorBlock) {
    return { ok: false, reason: 'anchor block not found' };
  }

  const claimedOutputs = resolveClaimedOutputs(block, anchorBlock, store);

  // Check if any claimed output is a status output
  let requiredPublicKey: Uint8Array | undefined;
  for (const output of claimedOutputs) {
    if (Hash.equals(output.contract, statusHash)) {
      const { publicKey } = decodeStatusData(output.data);
      if (requiredPublicKey) {
        // Multiple status claims — they must all be for the same identity
        if (!bytesEqual(requiredPublicKey, publicKey)) {
          return { ok: false, reason: 'block claims status outputs for multiple identities' };
        }
      } else {
        requiredPublicKey = publicKey;
      }
    }
  }

  // Also check produced status outputs — their publicKey must match the signer
  for (const output of block.outputs) {
    if (Hash.equals(output.contract, statusHash)) {
      const { publicKey } = decodeStatusData(output.data);
      if (requiredPublicKey) {
        if (!bytesEqual(requiredPublicKey, publicKey)) {
          return {
            ok: false,
            reason: 'produced status output publicKey does not match claimed output',
          };
        }
      } else {
        requiredPublicKey = publicKey;
      }
    }
  }

  // If no status outputs are involved, no signature check needed
  if (!requiredPublicKey) {
    return { ok: true };
  }

  // Verify signature matches the required publicKey
  if (!verifyBlockSignature(sb, requiredPublicKey)) {
    return { ok: false, reason: 'signature does not match status output owner' };
  }

  return { ok: true };
}

/**
 * Resolve claimed outputs by mapping claim indices into the anchor block's
 * extended output vector.
 *
 * Extended vector layout from the claiming block's perspective:
 *   [own outputs (0..outputs.length-1), surviving anchor outputs...]
 *
 * For non-self claims (index >= outputs.length), we need to find the actual
 * Output object from the anchor's extended vector.
 */
function resolveClaimedOutputs(block: Block, anchorBlock: Block, store: BlockStore): Output[] {
  const results: Output[] = [];
  const anchorExtended = collectExtendedOutputs(anchorBlock, store);
  const ownOutputCount = block.outputs.length;

  for (const claimIndex of block.claims) {
    if (claimIndex < ownOutputCount) {
      // Self-claim — claims own output, skip
      continue;
    }

    // Map from extended vector index to anchor's extended outputs
    // Index into anchor extended = claimIndex - ownOutputCount
    const anchorIdx = claimIndex - ownOutputCount;
    if (anchorIdx < anchorExtended.length) {
      results.push(anchorExtended[anchorIdx]);
    }
  }

  return results;
}

/**
 * Collect the full extended output vector of a block.
 * This is the set of outputs visible to any block that anchors to this one.
 *
 * Extended vector = [own outputs, surviving anchor outputs after claims]
 */
function collectExtendedOutputs(block: Block, store: BlockStore): Output[] {
  const result: Output[] = [...block.outputs];

  if (Hash.equals(block.anchor, ZERO_HASH)) {
    // Genesis — only own outputs
    return result;
  }

  const anchorBlock = store.get(block.anchor);
  if (!anchorBlock) return result;

  const anchorOutputs = collectExtendedOutputs(anchorBlock, store);
  const claimMask = getBlockClaimMask(block, anchorOutputs.length);

  // Add surviving anchor outputs (those not claimed by this block)
  for (let i = 0; i < anchorOutputs.length; i++) {
    if (!claimMask.get(i)) {
      result.push(anchorOutputs[i]);
    }
  }

  return result;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
