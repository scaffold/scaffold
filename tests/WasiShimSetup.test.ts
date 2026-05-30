// Unit tests for src/contracts/wasi-shim/setup.ts.
//
// Covers the pure JSON/data shaping; the loadShim filesystem path is
// environment-dependent (depends on `zig build` having run) and is not
// exercised here.

import { assert, assertEquals, assertThrows } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { ContractRejection } from '../src/core/ContractEnv.ts';
import {
  buildContractRecords,
  EXIT_ZERO_REASON,
  type WasiSetup,
  withExitRecognition,
} from '../src/contracts/wasi-shim/setup.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8d = (b: Uint8Array): string => new TextDecoder().decode(b);

function parseRecord(bytes: unknown): unknown {
  assert(bytes instanceof Uint8Array, 'expected record body to be Uint8Array');
  return JSON.parse(utf8d(bytes));
}

// Tiny stub blobs -- buildContractRecords doesn't parse them.
const STUB_SHIM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const STUB_PROG = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff]);

Deno.test('buildContractRecords: modules JSON has expected shape', () => {
  const out = buildContractRecords({ shimBytes: STUB_SHIM, programBytes: STUB_PROG });

  // The modules record is an in-memory object (the snapshot helper handles
  // the JSON-stringification step), not a Uint8Array.
  const modules = out.records.modules as Record<string, unknown>;
  const base = modules.base as Record<string, unknown>;
  assertEquals(base.version, 20250510);
  assertEquals((base.imports as Record<string, string>).run, 'wasi_shim:run');

  const layers = modules.layers as Array<Record<string, unknown>>;
  assertEquals(layers.length, 2, 'expected wasi_shim then program');
  const [shimLayer, progLayer] = layers;
  // Array order is the instantiation order: shim first, program second.
  assertEquals(shimLayer.key, 'wasi_shim');
  assertEquals(progLayer.key, 'program');

  const shimHex = Hash.digest(STUB_SHIM).toHex();
  const progHex = Hash.digest(STUB_PROG).toHex();
  assertEquals(shimLayer.wasmHash, shimHex);
  assertEquals(progLayer.wasmHash, progHex);

  const shimImports = shimLayer.imports as Record<string, string>;
  assertEquals(shimImports['program._start'], 'program:_start');
  assertEquals(shimImports['program_mem.read_bytes'], 'program:memory@read');
  assertEquals(shimImports['program_mem.write_bytes'], 'program:memory@write');
  assertEquals(shimImports['scaffold_env.*'], 'base:*');

  const progImports = progLayer.imports as Record<string, string>;
  assertEquals(progImports['wasi_snapshot_preview1.*'], 'wasi_shim:*');

  // Blobs map is keyed by hex hash, contains both bytes.
  assertEquals(out.blobs[shimHex], STUB_SHIM);
  assertEquals(out.blobs[progHex], STUB_PROG);
});

Deno.test('buildContractRecords: wasi_setup omits all defaults when absent', () => {
  const out = buildContractRecords({ shimBytes: STUB_SHIM, programBytes: STUB_PROG });
  assertEquals(parseRecord(out.records.wasi_setup), {});
});

Deno.test('buildContractRecords: wasi_setup omits fields equal to defaults', () => {
  const setup: WasiSetup = {
    argv: ['program'], // == default
    cwd: '/scratch', // != default
    env: {}, // == default
    stdin: '/dev/null', // == default
  };
  const out = buildContractRecords({
    shimBytes: STUB_SHIM,
    programBytes: STUB_PROG,
    setup,
  });
  assertEquals(parseRecord(out.records.wasi_setup), { cwd: '/scratch' });
});

Deno.test('buildContractRecords: wasi_setup keeps non-default fields', () => {
  const setup: WasiSetup = {
    argv: ['asc', '/in/params'],
    env: { K: 'V' },
    cwd: '/scratch',
    preopens: ['/in', '/out'],
    stdin: '/dev/zero',
    extra_fds: { '7': '/dev/random' },
  };
  const out = buildContractRecords({
    shimBytes: STUB_SHIM,
    programBytes: STUB_PROG,
    setup,
  });
  const decoded = parseRecord(out.records.wasi_setup) as Record<string, unknown>;
  assertEquals(decoded.argv, ['asc', '/in/params']);
  assertEquals(decoded.env, { K: 'V' });
  assertEquals(decoded.cwd, '/scratch');
  assertEquals(decoded.preopens, ['/in', '/out']);
  assertEquals(decoded.stdin, '/dev/zero');
  assertEquals(decoded.extra_fds, { '7': '/dev/random' });
  // Defaulted stdout/stderr are omitted.
  assert(!('stdout' in decoded), 'expected default stdout to be omitted');
  assert(!('stderr' in decoded), 'expected default stderr to be omitted');
});

Deno.test('buildContractRecords: wasi_setup keys are emitted in sorted order', () => {
  // Caller insertion order is jumbled; serialised JSON must come out sorted.
  const setup: WasiSetup = {
    stdout: '/out/custom',
    argv: ['x'],
    env: { Z: '1' },
    cwd: '/scratch',
  };
  const out = buildContractRecords({
    shimBytes: STUB_SHIM,
    programBytes: STUB_PROG,
    setup,
  });
  const json = utf8d(out.records.wasi_setup as Uint8Array);
  // Walk the raw string to capture insertion order in JSON output.
  const keys: string[] = [];
  for (const m of json.matchAll(/"([a-z_]+)"\s*:/g)) keys.push(m[1]);
  assertEquals(keys, ['argv', 'cwd', 'env', 'stdout']);
});

Deno.test('buildContractRecords: output_namespaces is concatenated 32-byte contract hashes', () => {
  // Matches wasm-abi.md + WasmContractPlugin.readOutputNamespaces: contract
  // hashes only (params are not part of a namespace's on-chain identity).
  const ns0Contract = Hash.digest('contract-zero');
  const ns1Contract = Hash.digest('contract-one');
  const out = buildContractRecords({
    shimBytes: STUB_SHIM,
    programBytes: STUB_PROG,
    outputNamespaces: [
      { contract: ns0Contract, params: utf8('ignored') },
      { contract: ns1Contract, params: new Uint8Array(0) },
    ],
  });
  const body = out.records.output_namespaces;
  assert(body instanceof Uint8Array);
  assertEquals(body.length, 64);
  assertEquals(Hash.fromBytes(body.slice(0, 32)).toHex(), ns0Contract.toHex());
  assertEquals(Hash.fromBytes(body.slice(32, 64)).toHex(), ns1Contract.toHex());
});

Deno.test('buildContractRecords: empty outputNamespaces produces zero bytes', () => {
  const out = buildContractRecords({ shimBytes: STUB_SHIM, programBytes: STUB_PROG });
  const body = out.records.output_namespaces;
  assert(body instanceof Uint8Array);
  assertEquals(body.length, 0);
});

Deno.test('withExitRecognition: swallows ContractRejection with EXIT_ZERO_REASON', () => {
  const result = withExitRecognition<number>(() => {
    throw new ContractRejection(EXIT_ZERO_REASON);
  });
  assertEquals(result, undefined);
});

Deno.test('withExitRecognition: re-throws ContractRejection with other message', () => {
  assertThrows(
    () =>
      withExitRecognition(() => {
        throw new ContractRejection('boom');
      }),
    ContractRejection,
    'boom',
  );
});

Deno.test('withExitRecognition: re-throws regular Error', () => {
  assertThrows(
    () =>
      withExitRecognition(() => {
        throw new Error('not a rejection');
      }),
    Error,
    'not a rejection',
  );
});

Deno.test('withExitRecognition: returns the wrapped function value on success', () => {
  const result = withExitRecognition<string>(() => 'ok');
  assertEquals(result, 'ok');
});
