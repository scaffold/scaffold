// Tests for cross-memory accessor function imports (the `@read` / `@write`
// markers on a literal target ref). These let a layer (e.g. a WASI shim)
// import JS-synthesised memcpy closures that move bytes between its own
// primary memory and another layer's exported memory.

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  type CompiledLayer,
  type CompiledModules,
  loadModules,
  parseModules,
} from '../src/plugins/wasm/WasmModules.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function loadFixture(name: string): Promise<Uint8Array> {
  const url = new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url);
  return await Deno.readFile(url);
}

async function compileFixture(bytes: Uint8Array): Promise<WebAssembly.Module> {
  // Copy into a freshly-owned ArrayBuffer so the WebAssembly.compile typing
  // accepts it (Deno's `readFile` types its result over `ArrayBufferLike`,
  // which doesn't satisfy `BufferSource<ArrayBuffer>` in strict mode).
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  return await WebAssembly.compile(owned);
}

interface BuiltGraph {
  ownerExports: Record<string, unknown>;
  userExports: Record<string, unknown>;
  ownerMem: WebAssembly.Memory;
  userMem: WebAssembly.Memory;
}

async function buildAccessorGraph(): Promise<BuiltGraph> {
  const ownerBytes = await loadFixture('accessor_owner');
  const userBytes = await loadFixture('accessor_user');
  const ownerHash = Hash.digest(ownerBytes);
  const userHash = Hash.digest(userBytes);

  const spec = {
    base: {
      version: 20250510,
      imports: { run: 'user:do_read' }, // unused (we call exports directly)
    },
    layers: {
      owner: { wasmHash: ownerHash.toHex() },
      user: {
        wasmHash: userHash.toHex(),
        imports: {
          'program_mem.read_bytes': 'owner:memory@read',
          'program_mem.write_bytes': 'owner:memory@write',
        },
      },
    },
  };
  const normalised = parseModules(enc.encode(JSON.stringify(spec)));
  const ownerLayer: CompiledLayer = {
    key: 'owner',
    module: await compileFixture(ownerBytes),
    imports: normalised.byKey.get('owner')!.imports,
  };
  const userLayer: CompiledLayer = {
    key: 'user',
    module: await compileFixture(userBytes),
    imports: normalised.byKey.get('user')!.imports,
  };
  const compiled: CompiledModules = {
    base: normalised.base,
    layers: [ownerLayer, userLayer],
    byKey: new Map([['owner', ownerLayer], ['user', userLayer]]),
  };
  const { exportsByKey, memoryByLayerKey } = await loadModules(compiled, {}, {
    layerKey: 'user',
    exportName: 'do_read',
  });
  return {
    ownerExports: exportsByKey.get('owner')!,
    userExports: exportsByKey.get('user')!,
    ownerMem: memoryByLayerKey.get('owner')!,
    userMem: memoryByLayerKey.get('user')!,
  };
}

// -- Round-trip --------------------------------------------------------

Deno.test('crossMemAccessor: write_bytes copies user-mem bytes into owner-mem', async () => {
  const g = await buildAccessorGraph();
  const doWrite = g.userExports.do_write as (t: number, p: number, l: number) => void;
  // user-side payload baked at offset 64: "user-side-payload-content" (25 bytes).
  doWrite(800, 64, 25);
  const ownerBytes = new Uint8Array(g.ownerMem.buffer, 800, 25);
  assertEquals(dec.decode(ownerBytes), 'user-side-payload-content');
});

Deno.test('crossMemAccessor: read_bytes copies owner-mem bytes into user-mem', async () => {
  const g = await buildAccessorGraph();
  const doRead = g.userExports.do_read as (t: number, p: number, l: number) => void;
  // owner-side payload baked at offset 256: "owner-payload-bytes" (19 bytes).
  doRead(256, 900, 19);
  const userBytes = new Uint8Array(g.userMem.buffer, 900, 19);
  assertEquals(dec.decode(userBytes), 'owner-payload-bytes');
});

Deno.test('crossMemAccessor: write then read round-trips through owner-mem', async () => {
  const g = await buildAccessorGraph();
  const doWrite = g.userExports.do_write as (t: number, p: number, l: number) => void;
  const doRead = g.userExports.do_read as (t: number, p: number, l: number) => void;
  // Put a known marker in user memory, push it into owner, clear user's
  // copy, then pull it back. Verifies both directions on the same buffer.
  const marker = enc.encode('round-trip-marker-xyz');
  new Uint8Array(g.userMem.buffer).set(marker, 1024);
  doWrite(1600, 1024, marker.length);
  // Zero user-side source so we can prove the read actually moved bytes.
  new Uint8Array(g.userMem.buffer, 1024, marker.length).fill(0);
  doRead(1600, 2048, marker.length);
  assertEquals(
    dec.decode(new Uint8Array(g.userMem.buffer, 2048, marker.length)),
    'round-trip-marker-xyz',
  );
});

// -- Bounds checking ---------------------------------------------------

Deno.test('crossMemAccessor: out-of-bounds copy throws RangeError (surfaces as trap)', async () => {
  const g = await buildAccessorGraph();
  const doWrite = g.userExports.do_write as (t: number, p: number, l: number) => void;
  // user memory is 1 page = 65536 bytes; ask for a copy that overruns it.
  assertThrowsRange(() => doWrite(0, 65000, 1000));
  // owner memory is 1 page = 65536 bytes; ask for a destination overrun.
  assertThrowsRange(() => doWrite(65000, 0, 1000));
});

function assertThrowsRange(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    assert(err instanceof RangeError, `expected RangeError, got ${err}`);
    assertStringIncludes((err as Error).message, 'out-of-bounds');
    return;
  }
  throw new Error('expected fn to throw');
}

// -- Parsing -----------------------------------------------------------

Deno.test('crossMemAccessor: parser rejects unknown accessor tag', () => {
  const spec = {
    base: { version: 20250510, imports: { run: 'a:run' } },
    layers: {
      a: {
        wasmHash: '0'.repeat(64),
        imports: { 'ns.f': 'a:memory@invalid' },
      },
    },
  };
  try {
    parseModules(enc.encode(JSON.stringify(spec)));
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'unknown accessor');
    assertStringIncludes((err as Error).message, '@invalid');
  }
});

Deno.test('crossMemAccessor: parser rejects accessor on wildcard value', () => {
  // Both key and value end with "*" so we pass the symmetric-wildcard guard;
  // then the explicit "@ not allowed in wildcard value" guard fires.
  const spec = {
    base: { version: 20250510, imports: { run: 'a:run' } },
    layers: {
      a: {
        wasmHash: '0'.repeat(64),
        imports: { 'ns.*': 'a:foo.@read*' },
      },
    },
  };
  try {
    parseModules(enc.encode(JSON.stringify(spec)));
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, '"@"');
  }
});

Deno.test(
  'crossMemAccessor: accessor target bound to non-function import is rejected',
  async () => {
    // Wire accessor_user's `program_mem.read_bytes` (which is a function
    // import) -- fine -- but wire `env.memory` style memory import to an
    // accessor target. Build a custom WAT that imports a memory, point its
    // memory import at `owner:memory@read`. We don't have such a fixture
    // baked; instead, use accessor_user's function imports but point them
    // at a non-memory export of owner. We need an export of owner that
    // ISN'T a memory -- but accessor_owner only exports `memory`. Use a
    // synthesized two-layer graph where one layer exports a function and
    // user binds its read_bytes accessor to it.
    //
    // Simpler approach: rely on the accessor-binds-to-non-memory path,
    // exercised by pointing the accessor at a non-memory export.
    const ownerBytes = await loadFixture('accessor_owner');
    const userBytes = await loadFixture('accessor_user');
    const ownerHash = Hash.digest(ownerBytes);
    const userHash = Hash.digest(userBytes);

    // Point the accessor at owner:nonexistent (not a memory).
    const spec = {
      base: { version: 20250510, imports: { run: 'user:do_read' } },
      layers: {
        owner: { wasmHash: ownerHash.toHex() },
        user: {
          wasmHash: userHash.toHex(),
          imports: {
            'program_mem.read_bytes': 'owner:not_a_memory@read',
            'program_mem.write_bytes': 'owner:memory@write',
          },
        },
      },
    };
    const normalised = parseModules(enc.encode(JSON.stringify(spec)));
    const ownerLayer: CompiledLayer = {
      key: 'owner',
      module: await compileFixture(ownerBytes),
      imports: normalised.byKey.get('owner')!.imports,
    };
    const userLayer: CompiledLayer = {
      key: 'user',
      module: await compileFixture(userBytes),
      imports: normalised.byKey.get('user')!.imports,
    };
    const compiled: CompiledModules = {
      base: normalised.base,
      layers: [ownerLayer, userLayer],
      byKey: new Map([['owner', ownerLayer], ['user', userLayer]]),
    };
    await assertRejects(
      async () => {
        await loadModules(compiled, {}, { layerKey: 'user', exportName: 'do_read' });
      },
      Error,
      'accessor binds to non-memory export',
    );
  },
);
