// Isolation tests for the generic JSON walker/builder module (json-wb.wasm),
// exercised directly through the in-process transport. build_params should
// assemble canonical JSON from a NestedBuilderHost via request_value_type +
// request_object_keys / request_array_length + the scalar requesters.
//
// Prerequisite: cd src/contracts/json-wb && zig build json-wb. Missing artifact
// skips cleanly.

import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  type CompiledLayer,
  type CompiledModules,
  parseModules,
} from '../src/plugins/wasm/WasmModules.ts';
import { InProcessMockTransport } from '../src/plugins/wasm/transports/InProcessMockTransport.ts';
import { createReader } from '../src/contract/Reader.ts';
import { type FieldNode, RecordingWalkerHost } from '../src/core/RecordingWalkerHost.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

const MODULES_VERSION = 20250510;
const WASM_URL = new URL('../src/contracts/json-wb/dist/json-wb.wasm', import.meta.url);

// Local canonical JSON (sorted keys) to avoid importing draftPublishing, which
// pulls in ContractHostService and creates an import cycle with WasmModules.
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

async function compileJsonWb(): Promise<CompiledModules> {
  const bytes = await Deno.readFile(WASM_URL);
  const hash = Hash.digest(bytes);
  // json-wb exports its own memory, so no base `memories` / `env.memory` import.
  const spec = {
    base: {
      version: MODULES_VERSION,
      imports: {
        build_params: 'main:build_params',
        build_body: 'main:build_body',
        walk_params: 'main:walk_params',
        walk_body: 'main:walk_body',
      },
    },
    layers: [{
      key: 'main',
      wasmHash: hash.toHex(),
      imports: { 'scaffold_builder.*': 'base:*', 'scaffold_walker.*': 'base:*' },
    }],
  };
  const normalised = parseModules(new TextEncoder().encode(JSON.stringify(spec)));
  const module = await WebAssembly.compile(bytes);
  const layer: CompiledLayer = { key: 'main', module, imports: normalised.layers[0].imports };
  return { base: normalised.base, layers: [layer], byKey: new Map([['main', layer]]) };
}

async function buildWith(compiled: CompiledModules, value: unknown): Promise<string> {
  const transport = new InProcessMockTransport();
  const out = await transport.buildParams(compiled, () => createReader(value));
  return bin2str(out);
}

// Mirror of FetchManager's walkerTreeToObject (not exported there).
function treeToObject(nodes: FieldNode[]): unknown {
  if (nodes.length === 1 && nodes[0].key === '') return nodeValue(nodes[0]);
  const out: Record<string, unknown> = {};
  for (const n of nodes) out[n.key] = nodeValue(n);
  return out;
}
function nodeValue(n: FieldNode): unknown {
  switch (n.kind) {
    case 'bytes':
    case 'string':
    case 'number':
    case 'bool':
      return n.value;
    case 'map':
      return treeToObject(n.children);
    case 'list':
      return n.children.map(nodeValue);
  }
}

async function walk(compiled: CompiledModules, json: string): Promise<unknown> {
  const transport = new InProcessMockTransport();
  const host = new RecordingWalkerHost();
  await transport.walkParams(compiled, str2bin(json), host);
  return treeToObject(host.getTree());
}

async function haveWasm(): Promise<boolean> {
  try {
    await Deno.stat(WASM_URL);
    return true;
  } catch {
    return false;
  }
}

Deno.test('json-wb build_params: object round-trips to canonical JSON', async (t) => {
  if (!(await haveWasm())) {
    await t.step({ name: 'skipped: json-wb.wasm not built', ignore: true, fn: () => {} });
    return;
  }
  const compiled = await compileJsonWb();
  const value = { name: 'World', age: 5, active: true, tags: ['a', 'b'], nested: { y: 2, x: 1 } };
  assertEquals(await buildWith(compiled, value), canonicalJson(value));
});

Deno.test('json-wb build_params: scalars and empties', async (t) => {
  if (!(await haveWasm())) {
    await t.step({ name: 'skipped: json-wb.wasm not built', ignore: true, fn: () => {} });
    return;
  }
  const compiled = await compileJsonWb();
  assertEquals(
    await buildWith(compiled, { s: 'hi"there\\', n: -42, b: false }),
    canonicalJson({ s: 'hi"there\\', n: -42, b: false }),
  );
  assertEquals(
    await buildWith(compiled, { empty: {}, list: [] }),
    canonicalJson({ empty: {}, list: [] }),
  );
});

Deno.test('json-wb walk_params: JSON parses into a value tree', async (t) => {
  if (!(await haveWasm())) {
    await t.step({ name: 'skipped: json-wb.wasm not built', ignore: true, fn: () => {} });
    return;
  }
  const compiled = await compileJsonWb();
  const value = { name: 'World', age: 5, active: true, tags: ['a', 'b'], nested: { x: 1, y: 2 } };
  assertEquals(await walk(compiled, JSON.stringify(value)), value);
});

Deno.test('json-wb round-trip: build then walk recovers the value', async (t) => {
  if (!(await haveWasm())) {
    await t.step({ name: 'skipped: json-wb.wasm not built', ignore: true, fn: () => {} });
    return;
  }
  const compiled = await compileJsonWb();
  const value = { a: 1, b: { c: [1, 2, 3] }, d: 'x', e: false };
  const built = await buildWith(compiled, value);
  assertEquals(await walk(compiled, built), value);
});
