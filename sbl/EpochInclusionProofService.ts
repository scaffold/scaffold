import { MessageType } from '~/sbl/ConnectionService.ts';
import Context from './Context.ts';
import PacketCoder, { SIGNATURE_LENGTH } from '~/sbl/PacketCoder.ts';
import { Block, EpochInclusionProof } from '~/sbl/messages.ts';
import BlockService from '~/sbl/BlockService.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import { BlockExt } from '~/sbl/BlockMeta.ts';
import { Node } from './NodeService.ts';

export default class EpochInclusionProofService {
  private pendingProofs = new Map<
    HashPrimitive,
    Map<HashPrimitive, EpochInclusionProof>
  >();

  constructor(private ctx: Context) {}

  public popEips(block: BlockExt) {
    const eips = this.pendingProofs.get(block.hash.toPrimitive());
    if (eips) {
      this.pendingProofs.delete(block.hash.toPrimitive());
      block.epochInclusionProofs = eips;
      eips.forEach((proof) => this.propagate(block, proof));
    }
  }

  public ingest(data: Uint8Array, fromNode: Node) {
    // TODO: Save EIP signature so if we re-broadcast it, an incorrect proof doesn't count against us

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

    const proof = EpochInclusionProof.decode(
      data.subarray(SIGNATURE_LENGTH + 1),
    );
    fromNode.knownObjects.add(proof);
    this.addProof(proof);
  }

  public addProof(proof: EpochInclusionProof) {
    const block = this.ctx.get(BlockService).get(proof.block_hash);
    if (block) {
      this.updateProof(block.epochInclusionProofs, proof, block);
    } else {
      this.updateProof(
        getOrCreate(
          this.pendingProofs,
          proof.block_hash.toPrimitive(),
          () => new Map(),
        ),
        proof,
      );
    }
  }

  public updateProof(
    map: Map<HashPrimitive, EpochInclusionProof>,
    proof: EpochInclusionProof,
    block?: BlockExt,
  ) {
    const prev = map.get(proof.epoch_hash.toPrimitive());
    if (
      prev === undefined ||
      proof.input_indices.length < prev.input_indices.length
    ) {
      map.set(proof.epoch_hash.toPrimitive(), proof);
      if (block) {
        this.propagate(block, proof);
      }
    }
  }

  public propagate(block: BlockExt, proof: EpochInclusionProof) {
    if (block.iceberg_depth <= proof.input_indices.length) {
      // No proof needed
      return;
    }

    const packet = this.ctx.get(PacketCoder).encode(
      proof,
      EpochInclusionProof,
      MessageType.EpochInclusionProof,
    );

    [...block.fromNodes, ...block.toNodes].forEach((node) => {
      if (!node.knownObjects.has(proof)) {
        node.knownObjects.add(proof);
        node.defaultConn?.sendReliable(packet);
      }
    });

    block.inputs.forEach(({ block_hash }, idx) =>
      this.addProof({
        block_hash,
        epoch_hash: proof.epoch_hash,
        input_indices: [...proof.input_indices, idx],
      })
    );
  }
}
