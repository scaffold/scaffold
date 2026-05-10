import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore, resolveClaimToOutput } from '../core/Block.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { verifyPacketSignature } from '../core/Packet.ts';
import { decodeStatusData, statusHash } from './StatusContract.ts';

/**
 * Validate a block's authorization. Throws on failure.
 *
 * Rules:
 * - Genesis (no anchor): always valid
 * - Blocks not claiming status outputs: always valid
 * - Blocks claiming status outputs: signature must match the publicKey in the claimed output data
 */
export function validateBlockPacket(block: Block, store: BlockStore): void {
  // Genesis is always valid
  if (Hash.equals(block.anchor, ZERO_HASH)) {
    return;
  }

  // Find which outputs this block claims by resolving claim indices
  // against the anchor's extended output vector
  const anchorBlock = store.get(block.anchor);
  if (!anchorBlock) {
    throw new Error('anchor block not found');
  }

  // anchorBlock is unused now (resolution goes through OutputSpaceModule),
  // but we keep the existence check above so a missing anchor still throws.
  void anchorBlock;
  const claimedOutputs = resolveClaimedOutputs(block, store);

  // Check if any claimed output is a status output
  let requiredPublicKey: Uint8Array | undefined;
  for (const output of claimedOutputs) {
    if (output.body === undefined) continue;
    if (Hash.equals(output.verifier.contract, statusHash)) {
      const { publicKey } = decodeStatusData(output.body);
      if (requiredPublicKey) {
        // Multiple status claims — they must all be for the same identity
        if (!bytesEqual(requiredPublicKey, publicKey)) {
          throw new Error('block claims status outputs for multiple identities');
        }
      } else {
        requiredPublicKey = publicKey;
      }
    }
  }

  // Also check produced status outputs — their publicKey must match the signer
  for (const output of block.outputs) {
    if (output.body === undefined) continue;
    if (Hash.equals(output.verifier.contract, statusHash)) {
      const { publicKey } = decodeStatusData(output.body);
      if (requiredPublicKey) {
        if (!bytesEqual(requiredPublicKey, publicKey)) {
          throw new Error('produced status output publicKey does not match claimed output');
        }
      } else {
        requiredPublicKey = publicKey;
      }
    }
  }

  // If no status outputs are involved, no signature check needed
  if (!requiredPublicKey) {
    return;
  }

  // Verify signature matches the required publicKey
  if (!verifyPacketSignature(block, requiredPublicKey)) {
    throw new Error('signature does not match status output owner');
  }
}

/**
 * Resolve each external claim to the producing block's output via
 * `OutputSpaceModule`. Self-claims are skipped: by definition they
 * point at one of `block.outputs` and aren't relevant to the
 * status-output authorization check.
 */
function resolveClaimedOutputs(block: Block, store: BlockStore): Output[] {
  const results: Output[] = [];
  const ownOutputCount = block.outputs.length;
  for (const claimIndex of block.claimIndices) {
    if (claimIndex < ownOutputCount) continue;
    const resolved = resolveClaimToOutput(block, claimIndex, store);
    if (resolved) results.push(resolved.output);
  }
  return results;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
