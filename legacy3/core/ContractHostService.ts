// Protocol spec: docs/protocol/computation.md

import { Block, BlockStore } from './Block.ts';
import { ContractHost } from './ContractHost.ts';
import { ProtocolContext } from './ProtocolContext.ts';

/**
 * ProtocolContext-registrable `ContractHost<Block>`.
 *
 * `ContractHost` itself is generic over `BlockType` so it can be tested
 * with lightweight block stand-ins. This subclass pins it to the real
 * `Block` type, wires the `BlockStore` for plugin lookups, and takes a
 * ProtocolContext constructor signature so it can be registered via
 * `ctx.get(ContractHostService)`.
 */
export class ContractHostService extends ContractHost<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super({ getBlock: (hash) => store.get(hash) });
  }
}
