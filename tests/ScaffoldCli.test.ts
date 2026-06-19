// Transition tests for the pure CLI: drive `ScaffoldCLI.call(argv)` with a
// fully mocked `ScaffoldCliDeps` and assert on the exit code plus the captured
// stdout/stderr/filesystem effects. No real I/O -- this is exactly the surface
// a browser host would drive.

import { assertEquals, assertStringIncludes } from '@std/assert';
import { ScaffoldCLI, type ScaffoldCliDeps } from '../src/cli/ScaffoldCLI.ts';
import type { Scaffold, ScaffoldConfig } from '../src/Scaffold.ts';
import { Hash } from '../src/util/Hash.ts';

// TODO(claude): Update these tests to match the slightly modified ScaffoldCLI interface

/** One recorded call against the mock Scaffold: the method name and its args. */
interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A stand-in `Scaffold` that records every method call into `calls` so tests can
 * assert on them. Reading a method returns a function; calling it logs
 * `{ method, args }` and returns the matching entry from `returns` (or undefined
 * if unstubbed -- `await`ing undefined is harmless). Symbols and `then` resolve
 * to undefined so the proxy is never mistaken for a thenable.
 *
 * Usage once put/fetch are wired:
 *   const h = harness({ scaffold: { put: () => ({ hash: 'ab12' }) } });
 *   await h.cli.call(['scaffold', 'put', './c.wasm']);
 *   assertEquals(h.scaffoldCalls()[0].method, 'put');
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

interface Harness {
  cli: ScaffoldCLI;
  out: () => string;
  err: () => string;
  files: Map<string, Uint8Array>;
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
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Uint8Array>(Object.entries(opts.files ?? {}));
  const scaffoldCalls: RecordedCall[] = [];
  const scaffoldConfigs: ScaffoldConfig[] = [];

  const deps: ScaffoldCliDeps = {
    constructScaffold: (config) => {
      scaffoldConfigs.push(config);
      return recordingScaffold(scaffoldCalls, opts.scaffold ?? {});
    },
    readFile: (path) => {
      const data = files.get(path);
      return data ? Promise.resolve(data) : Promise.reject(new Error(`no such file: ${path}`));
    },
    writeFile: (path, data) => {
      files.set(path, data);
      return Promise.resolve();
    },
    readStdin: () => Promise.resolve(opts.stdin ?? new Uint8Array()),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: (name) => opts.env?.[name],
    version: opts.version ?? 'test',
  };

  return {
    cli: new ScaffoldCLI(deps),
    out: () => out.join(''),
    err: () => err.join(''),
    files,
    scaffoldCalls: () => scaffoldCalls,
    scaffoldConfigs: () => scaffoldConfigs,
  };
}

Deno.test('no args prints usage and exits 0', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold']);
  assertEquals(code, 0);
  assertStringIncludes(h.out(), 'Usage:');
});

Deno.test('--help prints usage and exits 0', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', '--help']);
  assertEquals(code, 0);
  assertStringIncludes(h.out(), 'put');
  assertStringIncludes(h.out(), 'fetch');
});

Deno.test('--version reports the injected version', async () => {
  const h = harness({ version: '1.2.3' });
  const code = await h.cli.call(['scaffold', '--version']);
  assertEquals(code, 0);
  assertEquals(h.out(), '1.2.3\n');
});

Deno.test('-v reports the version from the dep (no built-in fallback)', async () => {
  const h = harness(); // harness default version is 'test'
  await h.cli.call(['scaffold', '-v']);
  assertEquals(h.out(), 'test\n');
});

Deno.test('unknown command exits EX_USAGE and shows usage', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'frobnicate']);
  assertEquals(code, 64);
  assertStringIncludes(h.err(), "unknown command 'frobnicate'");
  assertStringIncludes(h.err(), 'Usage:');
});

Deno.test('put hashes a file argument to its content id', async () => {
  const payload = new TextEncoder().encode('contract bytes');
  const h = harness({ files: { './c.wasm': payload } });
  const code = await h.cli.call(['scaffold', 'put', './c.wasm']);
  assertEquals(code, 0);
  assertEquals(h.out(), `${Hash.digest(payload).toHex()}\n`);
  // The not-yet-wired broadcast is surfaced, not hidden.
  assertStringIncludes(h.err(), 'not wired yet');
});

Deno.test('put reads stdin when no file is given', async () => {
  const payload = new TextEncoder().encode('piped');
  const h = harness({ stdin: payload });
  const code = await h.cli.call(['scaffold', 'put']);
  assertEquals(code, 0);
  assertEquals(h.out(), `${Hash.digest(payload).toHex()}\n`);
});

Deno.test('put -o writes the id to a file instead of stdout', async () => {
  const payload = new TextEncoder().encode('x');
  const h = harness({ stdin: payload });
  const code = await h.cli.call(['scaffold', 'put', '-', '-o', 'out.txt']);
  assertEquals(code, 0);
  assertEquals(h.out(), '');
  const written = h.files.get('out.txt');
  assertEquals(
    new TextDecoder().decode(written),
    `${Hash.digest(payload).toHex()}\n`,
  );
});

Deno.test('put with empty input is a usage error', async () => {
  const h = harness({ stdin: new Uint8Array() });
  const code = await h.cli.call(['scaffold', 'put']);
  assertEquals(code, 64);
  assertStringIncludes(h.err(), 'no input');
});

Deno.test('put surfaces a readFile failure as a generic error', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'put', './missing.wasm']);
  assertEquals(code, 1);
  assertStringIncludes(h.err(), 'no such file');
});

Deno.test('fetch without a hash is a usage error', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'fetch']);
  assertEquals(code, 64);
  assertStringIncludes(h.err(), 'missing <hash>');
});

Deno.test('fetch with a hash reports unavailable (not yet wired)', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'fetch', 'deadbeef']);
  assertEquals(code, 69);
  assertStringIncludes(h.err(), 'not implemented yet');
});

Deno.test('a string option missing its value is a usage error', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'fetch', 'deadbeef', '--params']);
  assertEquals(code, 64);
  assertStringIncludes(h.err(), 'requires a value');
});
