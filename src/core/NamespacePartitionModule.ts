// Protocol spec: docs/protocol/computation.md#output-namespaces
//              docs/protocol/block-creation.md (Structural Verification rule 5)

import { Hash, HashPrimitive } from '../util/Hash.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import type { OutputSlot } from './GeneratingEnv.ts';

// -- Types ---------------------------------------------------------

/**
 * One claim's contribution to the block's output namespace partition.
 * Captures the running verifier, its declared namespaces (from the
 * contract's static metadata), and the slots it emitted during
 * verification (what the contract claims to have produced).
 */
export interface OwnerContribution {
  readonly runningVerifier: Verifier;
  readonly declaredNamespaces: Hash[];
  readonly emittedSlots: OutputSlot[];
}

/** Result of a partition check. */
export type PartitionResult =
  | { ok: true }
  | { ok: false; reason: string };

// -- Module --------------------------------------------------------

/**
 * Block-level structural check for the output-namespace partition rule.
 *
 * Given the per-claim verifier emissions, confirms the block's outputs
 * layout is consistent with every owning contract's declared sequence:
 *
 *   1. At most one owner per namespace on a given block.
 *   2. Within every owned namespace, the block's outputs (in block order)
 *      equal, positionally, what the owning contract emitted.
 *      - For `requireOutput`: exact `(verifier, value, data)` match.
 *      - For `getOutput`: `verifier` and `data` exact; block's value may
 *        be >= emitted value (solidification-time raise).
 *   3. Unowned namespaces (no claim's contract declares them) are left to
 *      other protocol rules (e.g., the mandatory aggregation marker).
 */
export class NamespacePartitionModule {
  check(
    outputs: Output[],
    contributions: OwnerContribution[],
  ): PartitionResult {
    // Build owner map: namespaceHash -> contributing claim
    const owners = new Map<HashPrimitive, OwnerContribution>();
    for (const c of contributions) {
      for (const ns of c.declaredNamespaces) {
        const key = ns.toPrimitive();
        if (owners.has(key)) {
          return {
            ok: false,
            reason: `two owners for namespace ${ns.toHex()}`,
          };
        }
        owners.set(key, c);
      }
    }

    // Partition block outputs by contract hash, preserving order.
    const byNamespace = new Map<HashPrimitive, Output[]>();
    for (const output of outputs) {
      const key = output.verifier.contract.toPrimitive();
      let list = byNamespace.get(key);
      if (!list) {
        list = [];
        byNamespace.set(key, list);
      }
      list.push(output);
    }

    // For each owned namespace, compare block outputs to emitted slots.
    for (const [namespaceKey, owner] of owners) {
      const blockOutputs = byNamespace.get(namespaceKey) ?? [];
      const emittedForThisNamespace = owner.emittedSlots.filter((s) =>
        s.output.verifier.contract.toPrimitive() === namespaceKey
      );

      if (blockOutputs.length !== emittedForThisNamespace.length) {
        return {
          ok: false,
          reason: `namespace ${
            Hash.fromPrimitive(namespaceKey).toHex()
          }: block has ${blockOutputs.length} outputs, contract emitted ${emittedForThisNamespace.length}`,
        };
      }

      for (let i = 0; i < blockOutputs.length; i++) {
        const onBlock = blockOutputs[i];
        const emitted = emittedForThisNamespace[i].output;
        const origin = emittedForThisNamespace[i].origin;

        if (!verifierEquals(onBlock.verifier, emitted.verifier)) {
          return {
            ok: false,
            reason: `namespace ${
              Hash.fromPrimitive(namespaceKey).toHex()
            } slot ${i}: verifier mismatch`,
          };
        }
        // Null-data outputs (pure-incentive) must live in unowned
        // namespaces -- contracts cannot emit them, so a null-data slot
        // in an owned namespace is a partition violation.
        if (onBlock.data === null) {
          return {
            ok: false,
            reason: `namespace ${
              Hash.fromPrimitive(namespaceKey).toHex()
            } slot ${i}: null-data output in owned namespace`,
          };
        }
        // `emitted.data` is always non-null by construction (the env
        // only records non-null data for require/get slots).
        if (emitted.data === null) {
          return {
            ok: false,
            reason: `namespace ${
              Hash.fromPrimitive(namespaceKey).toHex()
            } slot ${i}: emitted slot has null data (should be impossible)`,
          };
        }
        if (!bytesEqual(onBlock.data, emitted.data)) {
          return {
            ok: false,
            reason: `namespace ${
              Hash.fromPrimitive(namespaceKey).toHex()
            } slot ${i}: data mismatch`,
          };
        }
        if (origin === 'get') {
          // Solidification may raise value, not lower it.
          if (onBlock.value < emitted.value) {
            return {
              ok: false,
              reason: `namespace ${
                Hash.fromPrimitive(namespaceKey).toHex()
              } slot ${i}: get-output value lowered (${emitted.value} -> ${onBlock.value})`,
            };
          }
        } else {
          // requireOutput: exact value match.
          if (onBlock.value !== emitted.value) {
            return {
              ok: false,
              reason: `namespace ${
                Hash.fromPrimitive(namespaceKey).toHex()
              } slot ${i}: value mismatch (expected ${emitted.value}, got ${onBlock.value})`,
            };
          }
        }
      }
    }

    return { ok: true };
  }
}

// -- Helpers -------------------------------------------------------

function verifierEquals(a: Verifier, b: Verifier): boolean {
  return Hash.equals(a.contract, b.contract) && bytesEqual(a.params, b.params);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
