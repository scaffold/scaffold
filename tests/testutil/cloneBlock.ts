// In production, every inbound block crosses a `PeerConnection` that
// deserializes a fresh atom from raw bytes -- so each node owns its own
// atom with its own `fromConnections`. Test harnesses (TestNetwork, the
// e2e wire shim) deliver one Block reference into multiple nodes, which
// would let `RoutingProvider.recordSource` accumulate `fromConnections`
// across hops and break reverse-path routing past the first hop.
//
// `cloneBlockForReception` mints a per-node copy: same payload + identity,
// fresh transit fields. Use it at any test boundary where one node hands
// a block to another.

import { Block } from '../../src/core/Block.ts';

export function cloneBlockForReception(block: Block): Block {
  return {
    ...block,
    fromConnections: [],
    toConnections: new Set(),
  };
}
