// Transition tests for the pure CLI: drive `ScaffoldCLI.call(argv)` with a
// fully mocked `ScaffoldCliDeps` and assert on the exit code plus the captured
// stdout (bytes), stderr (lines), and the calls/config handed to the Scaffold
// instance. No real I/O -- this is exactly the surface a browser host would drive.

import { assertEquals, assertStringIncludes } from '@std/assert';
import {
  type FsNode,
  FsNodeType,
  ScaffoldCLI,
  type ScaffoldCliDeps,
} from '../src/cli/ScaffoldCLI.ts';
import type { Scaffold, ScaffoldConfig } from '../src/Scaffold.ts';
import { Hash } from '../src/util/Hash.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** One recorded call against the mock Scaffold: the method name and its args. */
interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A stand-in `Scaffold` that records every method call into `calls` so tests can
 * assert on them. Reading a method returns a function; calling it logs
 * `{ method, args }` and returns the matching entry from `returns` (or undefined
 * if unstubbed). Symbols and `then` resolve to undefined so the proxy is never
 * mistaken for a thenable.
 */
function recordingScaffold(
  calls: RecordedCall[],
  returns: Record<string, (...args: unknown[]) => unknown>,
): Scaffold {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return returns[prop]?.(...args);
      };
    },
  }) as unknown as Scaffold;
}

/** Minimal in-memory `open`: maps known paths to file nodes, else Missing. */
function makeOpen(files: Record<string, Uint8Array>): ScaffoldCliDeps['open'] {
  return (path) => {
    const data = files[path];
    if (data === undefined) return Promise.resolve({ type: FsNodeType.Missing });
    const node: FsNode = {
      type: FsNodeType.File,
      read: () => Promise.resolve(data),
      write: () => Promise.resolve(),
    };
    return Promise.resolve(node);
  };
}

interface Harness {
  cli: ScaffoldCLI;
  /** Concatenated stdout decoded as UTF-8. */
  out: () => string;
  /** Concatenated raw stdout bytes (for binary `fetch` output). */
  outBytes: () => Uint8Array;
  /** stderr lines joined by newlines. */
  err: () => string;
  /** Method calls made against the constructed Scaffold, in order. */
  scaffoldCalls: () => RecordedCall[];
  /** Configs passed to each `constructScaffold` call, in order. */
  scaffoldConfigs: () => ScaffoldConfig[];
}

function harness(opts: {
  files?: Record<string, Uint8Array>;
  stdin?: Uint8Array;
  env?: Record<string, string>;
  version?: string;
  /** Per-method return stubs for the mock Scaffold, keyed by method name. */
  scaffold?: Record<string, (...args: unknown[]) => unknown>;
} = {}): Harness {
  const out: Uint8Array[] = [];
  const err: string[] = [];
  const scaffoldCalls: RecordedCall[] = [];
  const scaffoldConfigs: ScaffoldConfig[] = [];

  const deps: ScaffoldCliDeps = {
    constructScaffold: (config) => {
      scaffoldConfigs.push(config);
      return recordingScaffold(scaffoldCalls, opts.scaffold ?? {});
    },
    open: makeOpen(opts.files ?? {}),
    readStdin: () => Promise.resolve(opts.stdin ?? new Uint8Array()),
    stdout: (data) => out.push(data),
    stderr: (line) => err.push(line),
    env: (name) => opts.env?.[name],
    version: opts.version ?? 'test',
  };

  const concat = (): Uint8Array => {
    let total = 0;
    for (const c of out) total += c.length;
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of out) {
      buf.set(c, offset);
      offset += c.length;
    }
    return buf;
  };

  return {
    cli: new ScaffoldCLI(deps),
    out: () => dec.decode(concat()),
    outBytes: concat,
    err: () => err.join('\n'),
    scaffoldCalls: () => scaffoldCalls,
    scaffoldConfigs: () => scaffoldConfigs,
  };
}

const HASH_A = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);

Deno.test('no args prints usage to stdout and exits USAGE', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold']);
  assertEquals(code, 64);
  assertStringIncludes(h.out(), 'Usage:');
});

Deno.test('--help prints usage and exits OK', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', '--help']);
  assertEquals(code, 0);
  assertStringIncludes(h.out(), 'put');
  assertStringIncludes(h.out(), 'fetch');
});

Deno.test('help subcommand prints usage and exits OK', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'help']);
  assertEquals(code, 0);
  assertStringIncludes(h.out(), 'Usage:');
});

Deno.test('--version reports the injected version', async () => {
  const h = harness({ version: '1.2.3' });
  const code = await h.cli.call(['scaffold', '--version']);
  assertEquals(code, 0);
  assertEquals(h.out(), '1.2.3\n');
});

Deno.test('-v reports the dep version (no built-in fallback)', async () => {
  const h = harness(); // harness default version is 'test'
  await h.cli.call(['scaffold', '-v']);
  assertEquals(h.out(), 'test\n');
});

Deno.test('unknown command exits USAGE and shows usage', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'frobnicate']);
  assertEquals(code, 64);
  assertStringIncludes(h.err(), "unknown command 'frobnicate'");
  assertStringIncludes(h.out(), 'Usage:');
});

Deno.test('put runs the contract and prints hash + records as JSON', async () => {
  const h = harness({
    scaffold: { put: () => ({ hash: Hash.fromHex(HASH_B), outputs: [] }) },
  });
  const code = await h.cli.call(['scaffold', 'put', HASH_A, 'params.json', 'records.json']);
  assertEquals(code, 0);
  assertEquals(h.scaffoldCalls()[0].method, 'put');
  const printed = JSON.parse(h.out());
  assertEquals(printed.hash, HASH_B);
  assertEquals(printed.records, []);
});

Deno.test('put with the wrong number of positionals is a usage error', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'put', HASH_A]);
  assertEquals(code, 64);
  assertStringIncludes(h.err(), '3 positional arguments');
});

Deno.test('fetch resolves a contract output and writes the body to stdout', async () => {
  const body = enc.encode('resolved-body');
  const h = harness({ scaffold: { fetch: () => ({ body }) } });
  const code = await h.cli.call(['scaffold', 'fetch', HASH_A, 'params.json']);
  assertEquals(code, 0);
  assertEquals(h.scaffoldCalls()[0].method, 'fetch');
  assertEquals(h.outBytes(), body);
});

Deno.test('fetch with the wrong number of positionals is a usage error', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'fetch', HASH_A]);
  assertEquals(code, 64);
  assertStringIncludes(h.err(), '2 positional arguments');
});

Deno.test('--private_key_file is read through open into the scaffold config', async () => {
  const key = enc.encode('secret-key-bytes');
  const h = harness({
    files: { 'key.bin': key },
    scaffold: { put: () => ({ hash: Hash.fromHex(HASH_B), outputs: [] }) },
  });
  const code = await h.cli.call([
    'scaffold',
    'put',
    HASH_A,
    'params.json',
    'records.json',
    '--private_key_file',
    'key.bin',
  ]);
  assertEquals(code, 0);
  assertEquals(h.scaffoldConfigs()[0].privateKey, key);
});

Deno.test('--bootstrap_urls is split into the scaffold config', async () => {
  const h = harness({
    scaffold: { put: () => ({ hash: Hash.fromHex(HASH_B), outputs: [] }) },
  });
  await h.cli.call([
    'scaffold',
    'put',
    HASH_A,
    'params.json',
    'records.json',
    '--bootstrap_urls',
    'wss://a.example,wss://b.example',
  ]);
  assertEquals(h.scaffoldConfigs()[0].bootstrapUrls, ['wss://a.example', 'wss://b.example']);
});
