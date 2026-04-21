import { BlockStore } from '../core/Block.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { UtxoIndex } from './UtxoIndex.ts';

/**
 * ProtocolContext-registrable `UtxoIndex`. Wiring the canonicality
 * listener (blocks *or* drafts) is still the caller's job -- see
 * `NodeContext` / `SimNetwork` for the pattern.
 */
export class UtxoIndexService extends UtxoIndex {
  constructor(ctx: ProtocolContext) {
    super(ctx.get(BlockStore));
  }
}
