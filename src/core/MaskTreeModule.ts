/*
Merkle tree
The remaining size of the bitvector is either embedded directly or the next branches are outputs.
MAYBE: For branch outputs, the params also includes the hash of the (1) branch hashes or (2) leaf bitvector of the next level.
For branch outputs, the params includes the bitvector size and population.

I think there needs to be some commitment so other generators can easily verify.

Positive varint encoding of the number of zeros to skip

A generator can emit multiple blocks.
Iterate all tree children, creating a vector.
Once you have the entire vector (so you know they're not withholding anything):
Chunk the bit vector and aggregate into an internal tree.
Descend breadth-first into the tree, emitting each node as a block.
The whole thing is atomic - only once generation is done can you publish the blocks.
*/

// Protocol spec: docs/protocol/anchoring.md

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { BitVector } from './BitVector.ts';
import { mapOriginalToSurviving, mapSurvivingToOriginal } from './OutputMapping.ts';

export interface MaskTreeProvider<BlockType> {

}

export class MaskTreeModule<BlockType> {
  constructor(private readonly provider: MaskTreeProvider<BlockType>) {
  }


}
