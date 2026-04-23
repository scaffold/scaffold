// Protocol spec: docs/protocol/computation.md#host-handler-registration

import { Hash, HashPrimitive } from '../util/Hash.ts';
import type { Verifier } from './BlockCreationModule.ts';
import type { ProtocolContext } from './ProtocolContext.ts';

/**
 * A handler that can synthesize the `(value, data)` for a `getOutput`
 * request during generation. Returns `null` to defer to the next handler
 * in the chain. A non-null return terminates resolution.
 *
 * - `runningParams`: the params of the verifier whose contract is running.
 * - `outputVerifier`: the verifier the contract is requesting an output under.
 */
export type OutputHandler = (
  runningParams: Uint8Array,
  outputVerifier: Verifier,
) => Promise<{ value: number; data: Uint8Array } | null>;

/**
 * Fallback chain for `getOutput` resolution during generation.
 *
 * Resolution order (first non-null wins):
 *   1. Built-in Scaffold resolvers, in registration order.
 *   2. User handlers for the running contract hash, in registration order.
 *   3. If nothing matched, returns `null` and the caller blocks (the
 *      contract awaits restart-on-uncanonical, mirroring `requireInput`).
 *
 * See docs/protocol/computation.md#host-handler-registration.
 */
export class OutputHandlerRegistry {
  private readonly _builtins: OutputHandler[] = [];
  private readonly _userHandlers = new Map<HashPrimitive, OutputHandler[]>();

  /** Context-registrable constructor. Arg is ignored; registry has no deps. */
  constructor(_ctx?: ProtocolContext) {}

  /**
   * Register a built-in resolver. Built-ins are tried before any user
   * handler and must be order-deterministic across honest nodes. Intended
   * for protocol-level lookups (blob registry, UTXO index, aggregation
   * incentive computation).
   */
  registerBuiltin(handler: OutputHandler): void {
    this._builtins.push(handler);
  }

  /**
   * Register a user-space handler scoped to a running contract hash.
   * Handlers for the same contract run in registration order. Returns an
   * unsubscribe function.
   */
  registerUser(runningContract: Hash, handler: OutputHandler): () => void {
    const key = runningContract.toPrimitive();
    let list = this._userHandlers.get(key);
    if (!list) {
      list = [];
      this._userHandlers.set(key, list);
    }
    list.push(handler);
    return () => {
      const current = this._userHandlers.get(key);
      if (!current) return;
      const i = current.indexOf(handler);
      if (i >= 0) current.splice(i, 1);
      if (current.length === 0) this._userHandlers.delete(key);
    };
  }

  /**
   * Resolve a `getOutput` request by iterating the fallback chain.
   * Returns `null` if no handler produced a result.
   */
  async resolve(
    runningContract: Hash,
    runningParams: Uint8Array,
    outputVerifier: Verifier,
  ): Promise<{ value: number; data: Uint8Array } | null> {
    for (const handler of this._builtins) {
      const result = await handler(runningParams, outputVerifier);
      if (result !== null) return result;
    }
    const userList = this._userHandlers.get(runningContract.toPrimitive());
    if (userList) {
      for (const handler of userList) {
        const result = await handler(runningParams, outputVerifier);
        if (result !== null) return result;
      }
    }
    return null;
  }
}
