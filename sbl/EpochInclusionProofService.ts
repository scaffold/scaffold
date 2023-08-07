import { MessageType } from '~/sbl/ConnectionService.ts';
import Context from './Context.ts';
import { SIGNATURE_LENGTH } from '~/sbl/PacketCoder.ts';
import { EpochInclusionProof } from '~/sbl/messages.ts';
import BlockService from '~/sbl/BlockService.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import { BlockExt } from '~/sbl/BlockMeta.ts';

export default class EpochInclusionProofService {
  private pendingProofs = new Map<HashPrimitive, EpochInclusionProof[]>();

  constructor(private ctx: Context) {}

  public popEips(blockHash: Hash) {
    const eips = this.pendingProofs.get(blockHash.toPrimitive());
    if (eips) {
      this.pendingProofs.delete(blockHash.toPrimitive());
      return eips;
    } else {
      return [];
    }
  }

  public ingest(data: Uint8Array) {
    const signature = data.subarray(0, SIGNATURE_LENGTH);
    if (signature.byteLength !== SIGNATURE_LENGTH) {
      throw new Error(
        `Signature length (${signature.byteLength}) is not exactly ${SIGNATURE_LENGTH}`,
      );
    }

    if (data[SIGNATURE_LENGTH] !== MessageType.EpochInclusionProof) {
      throw new Error(
        `Cannot ingest non-eip (${data[SIGNATURE_LENGTH]}) as an eip`,
      );
    }

    const eip = EpochInclusionProof.decode(data.subarray(SIGNATURE_LENGTH + 1));
    const block = this.ctx.get(BlockService).get(eip.block_hash);
    if (block) {
      block.epochInclusionProofs.push(eip);
      this.propagate(block, eip);
    } else {
      getOrCreate(this.pendingProofs, eip.block_hash.toPrimitive(), () => [])
        .push(eip);
    }
  }

  public propagate(block: BlockExt, eip: EpochInclusionProof) {
    if (
      block.epochInclusionProofs.some((candidate) =>
        Hash.equals(candidate.epoch_hash, eip.epoch_hash) &&
        candidate.input_indices.length < eip.input_indices.length
      )
    ) {
      return;
    }
    block.inputs.forEach();
  }
}
