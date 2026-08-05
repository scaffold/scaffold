import { assertEquals, assertThrows } from '@std/assert';
import { encodeManifest, parseManifest } from '../../../src/contract/wasm/WasmManifest.ts';
import { str2bin } from '../../../src/util/buffer.ts';
import { Hash } from '../../../src/util/Hash.ts';

const MODULE = Hash.digest('module');

const manifest = (overrides: Record<string, unknown> = {}) =>
  str2bin(JSON.stringify({
    version: 1,
    module: MODULE.toHex(),
    entries: { run: 'run' },
    ...overrides,
  }));

Deno.test('parseManifest accepts a minimal manifest', () => {
  const parsed = parseManifest(manifest());
  assertEquals(parsed.version, 1);
  assertEquals(Hash.equals(parsed.module, MODULE), true);
  assertEquals(parsed.entries, { run: 'run' });
});

Deno.test('encodeManifest output parses back to the same manifest', () => {
  const parsed = parseManifest(encodeManifest({
    version: 1,
    module: MODULE,
    entries: { run: 'go', walk_params: 'wp' },
  }));
  assertEquals(Hash.equals(parsed.module, MODULE), true);
  assertEquals(parsed.entries, { run: 'go', walk_params: 'wp' });
});

Deno.test('parseManifest rejects non-JSON bytes', () => {
  assertThrows(() => parseManifest(str2bin('nope{')), Error, 'not valid JSON');
});

Deno.test('parseManifest rejects a JSON array', () => {
  assertThrows(() => parseManifest(str2bin('[]')), Error, 'must be a JSON object');
});

Deno.test('parseManifest rejects an unknown top-level key', () => {
  assertThrows(() => parseManifest(manifest({ layers: [] })), Error, 'unknown key "layers"');
});

Deno.test('parseManifest rejects a version other than 1', () => {
  assertThrows(() => parseManifest(manifest({ version: 2 })), Error, 'version must be 1');
});

Deno.test('parseManifest rejects a malformed module hash', () => {
  assertThrows(() => parseManifest(manifest({ module: 'abc' })), Error, '64-char hex');
});

Deno.test('parseManifest rejects an unknown entry point', () => {
  assertThrows(
    () => parseManifest(manifest({ entries: { run: 'run', setup: 'x' } })),
    Error,
    'unknown entry point "setup"',
  );
});

Deno.test('parseManifest rejects an empty export name', () => {
  assertThrows(
    () => parseManifest(manifest({ entries: { run: '' } })),
    Error,
    'must name an export',
  );
});

Deno.test('parseManifest requires a run entry', () => {
  assertThrows(
    () => parseManifest(manifest({ entries: { walk_params: 'wp' } })),
    Error,
    'must define a "run" entry',
  );
});
