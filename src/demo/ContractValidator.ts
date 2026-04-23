import { Hash, ZERO_HASH } from '../util/Hash.ts';
import {
  Block,
  BlockPayload,
  BlockSource,
  BlockStore,
  collectExtendedOutputs,
} from '../core/Block.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { Packet, verifyPacketSignature } from '../core/Packet.ts';
import { decodeStatusData, statusHash } from './StatusContract.ts';

/**
 * Validate a block packet's authorization. Throws on failure.
 *
 * Rules:
 * - Genesis (no anchor): always valid
 * - Blocks not claiming status outputs: always valid
 * - Blocks claiming status outputs: signature must match the publicKey in the claimed output data
 */
export function validateBlockPacket(packet: Packet<BlockPayload>, store: BlockStore): void {
  const block: Block = {
    hash: packet.hash,
    ...packet.payload,
    receivedAt: Date.now(),
    source: BlockSource.Remote,
  };

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

  const claimedOutputs = resolveClaimedOutputs(block, anchorBlock, store);

  // Check if any claimed output is a status output
  let requiredPublicKey: Uint8Array | undefined;
  for (const output of claimedOutputs) {
    if (output.data === null) continue;
    if (Hash.equals(output.verifier.contract, statusHash)) {
      const { publicKey } = decodeStatusData(output.data);
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
    if (output.data === null) continue;
    if (Hash.equals(output.verifier.contract, statusHash)) {
      const { publicKey } = decodeStatusData(output.data);
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
  if (!verifyPacketSignature(packet, requiredPublicKey)) {
    throw new Error('signature does not match status output owner');
  }
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
