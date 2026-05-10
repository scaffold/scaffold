// Protocol spec: docs/protocol/computation.md#host-handler-registration

import { Hash, HashPrimitive } from '../util/Hash.ts';
import type { Verifier } from './BlockCreationModule.ts';
import type { ProtocolContext } from './ProtocolContext.ts';
import { makeBlobRegistryResolver, makeUtxoResolver } from './builtinResolvers.ts';

/**
 * A handler that can synthesize the `(value, data)` for a `requestBody`
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
 * Fallback chain for `requestBody` resolution during generation.
 *
 * Resolution order (first non-null wins):
 *   1. Built-in Scaffold resolvers, in registration order.
 *   2. User handlers for the running contract hash, in registration order.
 *   3. If nothing matched, returns `null` and the caller blocks (the
 *      contract awaits restart-on-uncanonical, mirroring `claimNext`).
 *
 * See docs/protocol/computation.md#host-handler-registration.
 */
export class OutputHandlerRegistry {
  private readonly _builtins: OutputHandler[] = [];
  private readonly _userHandlers = new Map<HashPrimitive, OutputHandler[]>();
  /**
   * Listeners notified when a user handler is registered. Used by
   * `GenerationService` to wake generators parked in `waitForGetOutput`
   * after their first resolve pass found no non-null handler.
   */
  private readonly _onRegisterListeners: ((runningContract: Hash) => void)[] = [];

  /**
   * Context-registrable constructor. Wires up the built-in resolver
   * chain (blob registry, UTXO). The built-ins are stubs today; real
   * implementations land as follow-ups.
   */
  constructor(_ctx?: ProtocolContext) {
    this.registerBuiltin(makeBlobRegistryResolver());
    this.registerBuiltin(makeUtxoResolver());
  }

  /**
   * Subscribe to user-handler registrations. The callback fires every time
   * a new user handler is installed (after `registerUser` returns). Returns
   * an unsubscribe function. `GenerationService` uses this to retry parked
   * generators whose first `requestBody` resolution saw no handlers.
   */
  onUserHandlerRegistered(cb: (runningContract: Hash) => void): () => void {
    this._onRegisterListeners.push(cb);
    return () => {
      const i = this._onRegisterListeners.indexOf(cb);
      if (i >= 0) this._onRegisterListeners.splice(i, 1);
    };
  }

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
    for (const cb of this._onRegisterListeners) cb(runningContract);
    return () => {
      const current = this._userHandlers.get(key);
      if (!current) return;
      const i = current.indexOf(handler);
      if (i >= 0) current.splice(i, 1);
      if (current.length === 0) this._userHandlers.delete(key);
    };
  }

  /**
   * Resolve a `requestBody` request by iterating the fallback chain.
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
