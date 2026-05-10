// Protocol spec: docs/protocol/computation.md
//
// A `ContractPlugin` is consulted by `ContractHost.getContract(hash)` when
// the hash is not present in the built-in TS registry. The host loads the
// contract block by hash, walks plugins in registration order, and the
// first plugin that `accepts(block)` is asked to build a `Contract`. The
// result is cached by contract-hash so subsequent calls don't re-walk.
//
// Selection-by-hash and selection-by-metadata are both expressed via
// `accepts(block)` -- a plugin may inspect `block.hash`, any record output
// on the block (e.g. a `contract_type: wasm` marker), or any other block
// field. There is no separate "by hash" code path.

import type { Contract } from '../contracts/Contract.ts';

/**
 * A contract execution plugin. Each plugin claims responsibility for a
 * subset of contract blocks and produces a `Contract` impl for any block
 * it claims. Plugins compose: `ContractHost` walks them in registration
 * order until one accepts.
 */
export interface ContractPlugin<BlockType> {
  /** Does this plugin handle `block`? Pure inspection, no side effects. */
  accepts(block: BlockType): boolean;
  /**
   * Build a `Contract` impl backed by `block`. Only called when
   * `accepts(block)` returned true. Implementations may compile / parse
   * lazily inside the returned `Contract`'s methods.
   */
  getContract(block: BlockType): Contract;
}
