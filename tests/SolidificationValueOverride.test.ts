import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import type { Output } from '../src/core/BlockCreationModule.ts';
import type { OutputSlot } from '../src/core/GeneratingEnv.ts';

/**
 * Unit test: re-derive the pure _overrideGetOutputValues logic as a
 * standalone function, prove it raises 'get'-origin slot values and
 * leaves 'require' slots unchanged. Integration with NodeContext is
 * covered indirectly by existing end-to-end tests (nothing in-tree
 * calls requestBody yet, so the override is a no-op in the full pipeline
 * today).
 */

type ValueOverrideFn = (
  verifier: { contract: Hash; params: Uint8Array },
  body: Uint8Array,
  defaultValue: number,
) => number;

function overrideGetOutputValues(
  outputs: Output[],
  slots: OutputSlot[],
  fn: ValueOverrideFn | null,
): Output[] {
  return outputs.map((output, i) => {
    const slot = slots[i];
    if (!slot || slot.origin !== 'get') return output;
    if (!fn) return output;
    if (output.body === undefined) return output;
    const newValue = fn(output.verifier, output.body, output.value);
    if (newValue === output.value) return output;
    return { ...output, value: newValue };
  });
}

const enc = (s: string) => new TextEncoder().encode(s);
const hashOf = (s: string) => Hash.digest(s);

function out(
  value: number,
  origin: 'require' | 'get' = 'require',
): { output: Output; slot: OutputSlot } {
  const output: Output = {
    verifier: { contract: hashOf('c'), params: new Uint8Array(0) },
    value,
    body: enc('d'),
  };
  return { output, slot: { output, origin } };
}

Deno.test('override: get slot raised to hook return value', () => {
  const { output, slot } = out(1, 'get');
  const result = overrideGetOutputValues([output], [slot], () => 100);
  assertEquals(result[0].value, 100);
});

Deno.test('override: require slot left unchanged even with hook', () => {
  const { output, slot } = out(5, 'require');
  const result = overrideGetOutputValues([output], [slot], () => 999);
  assertEquals(result[0].value, 5);
});

Deno.test('override: no hook installed -> outputs unchanged', () => {
  const { output, slot } = out(7, 'get');
  const result = overrideGetOutputValues([output], [slot], null);
  assertEquals(result[0].value, 7);
});

Deno.test('override: hook returning same value produces no change', () => {
  const { output, slot } = out(7, 'get');
  const result = overrideGetOutputValues([output], [slot], (_v, _d, dv) => dv);
  assertEquals(result[0].value, 7);
  assertEquals(result[0], output); // same object ref
});

Deno.test('override: hook sees verifier + data + default value', () => {
  const { output, slot } = out(3, 'get');
  let seen: {
    verifier: { contract: Hash; params: Uint8Array };
    body: Uint8Array;
    defaultValue: number;
  } | undefined;
  overrideGetOutputValues([output], [slot], (verifier, body, defaultValue) => {
    seen = { verifier, body, defaultValue };
    return defaultValue;
  });
  assertEquals(seen!.defaultValue, 3);
  assertEquals(seen!.body, enc('d'));
});

Deno.test('override: mixed get + require slots', () => {
  const getOut = out(1, 'get');
  const reqOut = out(5, 'require');
  const result = overrideGetOutputValues(
    [getOut.output, reqOut.output],
    [getOut.slot, reqOut.slot],
    (_v, _d, dv) => dv * 10,
  );
  assertEquals(result[0].value, 10);
  assertEquals(result[1].value, 5);
});

Deno.test('override: slots shorter than outputs -> extra outputs unchanged', () => {
  const getOut = out(1, 'get');
  const extra = out(2, 'require');
  const result = overrideGetOutputValues(
    [getOut.output, extra.output],
    [getOut.slot], // only one slot tag
    () => 999,
  );
  assertEquals(result[0].value, 999);
  assertEquals(result[1].value, 2);
});
