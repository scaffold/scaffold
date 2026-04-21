import { BlockStore } from '../core/Block.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { UtxoIndex } from './UtxoIndex.ts';

/**
 * ProtocolContext-registrable `UtxoIndex`. Constructing via `ctx.get`
 * requires a single-argument constructor; this wrapper satisfies that
 * while preserving `UtxoIndex`'s construct-with-BlockStore usage for
 * callers that work outside the DI container.
 */
export class UtxoIndexService extends UtxoIndex {
  constructor(ctx: ProtocolContext) {
    super(ctx.get(BlockStore));
  }
}
