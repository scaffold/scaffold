// Helper for test fixtures that build a `Block` literal directly without
// going through `createBlockFromPacket`. Computes the three Node-projection
// fields (`kind`, `claims`, `effectiveWeight`) from the fields the fixture
// already owns. Two forms:
//
//   - blockNodeFields(hash, claimIndices, declaredWeight) -- returns just
//     the three fields, for spreading inside an existing literal.
//
//   - withNodeFields({ ...partialBlock }) -- wraps a partial Block literal
//     and adds the three fields, returning a full Block. Convenient when
//     the fixture doesn't have a local `hash` variable to reference.

import { Hash } from '../../src/util/Hash.ts';
import type { ClaimRef } from '../../src/core/Node.ts';

export function blockNodeFields(
  hash: Hash,
  claimIndices: number[] | readonly number[],
  declaredWeight: number,
): { kind: 'block'; claims: ClaimRef[]; effectiveWeight: number } {
  return {
    kind: 'block',
    claims: claimIndices.map((outputIndex) => ({ producer: hash, outputIndex })),
    effectiveWeight: declaredWeight,
  };
}

export function withNodeFields<
  T extends { hash: Hash; claimIndices: number[]; declaredWeight: number },
>(
  partial: T,
): T & { kind: 'block'; claims: ClaimRef[]; effectiveWeight: number } {
  return {
    ...partial,
    kind: 'block',
    claims: partial.claimIndices.map((outputIndex) => ({
      producer: partial.hash,
      outputIndex,
    })),
    effectiveWeight: partial.declaredWeight,
  };
}
