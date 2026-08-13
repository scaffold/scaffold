import { assertEquals } from '@std/assert';
import { makeDefaultConfig } from '../../src/Config.ts';
import { Context } from '../../src/Context.ts';
import { FsNodeType, ScaffoldCLI, ScaffoldCliDeps } from '../../src/cli/ScaffoldCLI.ts';
import { Scaffold, ScaffoldConfig } from '../../src/Scaffold.ts';
import { bin2str } from '../../src/util/buffer.ts';

function harness(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let captured: ScaffoldConfig | undefined;

  const deps: ScaffoldCliDeps = {
    constructScaffold: (config) => {
      captured = config;
      return new Scaffold(config);
    },
    open: () => Promise.resolve({ type: FsNodeType.Missing, error: new Error('no fs') }),
    readStdin: () => Promise.resolve(new Uint8Array()),
    stdout: (data) => void out.push(bin2str(data)),
    stderr: (line) => void err.push(line),
    env: (name) => env[name],
    version: '9.9.9',
  };

  return {
    cli: new ScaffoldCLI(deps),
    out,
    err,
    config: () => captured,
  };
}

Deno.test('a node with no logging provider hands out no loggers', () => {
  const ctx = new Context(makeDefaultConfig());
  assertEquals(ctx.logger('gossip'), undefined);
});

Deno.test('--version writes only to stdout', async () => {
  const h = harness();
  assertEquals(await h.cli.call(['scaffold', '--version']), 0);
  assertEquals(h.out.join(''), '9.9.9\n');
  assertEquals(h.err, []);
});

Deno.test('--help writes only to stdout', async () => {
  const h = harness();
  assertEquals(await h.cli.call(['scaffold', '--help']), 0);
  assertEquals(h.err, []);
  assertEquals(h.out.join('').includes('Usage:'), true);
});

Deno.test('an unknown command reports to stderr and exits non-zero', async () => {
  const h = harness();
  const code = await h.cli.call(['scaffold', 'bogus']);
  assertEquals(code, 64);
  assertEquals(h.err.join('').includes("unknown command 'bogus'"), true);
});

Deno.test('logging stays off unless asked for', async () => {
  const h = harness();
  await h.cli.call(['scaffold', 'put', 'x', 'y', 'z']).catch(() => {});
  assertEquals(h.config()?.loggingProvider, undefined);
});

Deno.test('--verbosity installs a provider that writes to stderr', async () => {
  const h = harness();
  await h.cli.call(['scaffold', '--verbosity', 'debug', 'put', 'x', 'y', 'z']).catch(() => {});

  const provider = h.config()?.loggingProvider;
  assertEquals(provider?.level('gossip'), 'debug');

  provider?.handle({
    system: 'gossip',
    event: 'ev',
    level: 'info',
    timestamp: 0,
    data: { a: 1 },
  });
  assertEquals(h.err.length, 1);
  assertEquals(h.err[0].includes('gossip ev'), true);
  assertEquals(h.out, []);
});

Deno.test('SCAFFOLD_LOG enables logging when --verbosity is absent', async () => {
  const h = harness({ SCAFFOLD_LOG: 'warn,gossip=debug' });
  await h.cli.call(['scaffold', 'put', 'x', 'y', 'z']).catch(() => {});

  const provider = h.config()?.loggingProvider;
  assertEquals(provider?.level('gossip'), 'debug');
  assertEquals(provider?.level('transport'), 'warn');
});

Deno.test('--verbosity takes precedence over SCAFFOLD_LOG', async () => {
  const h = harness({ SCAFFOLD_LOG: 'debug' });
  await h.cli.call(['scaffold', '--verbosity', 'error', 'put', 'x', 'y', 'z']).catch(() => {});
  assertEquals(h.config()?.loggingProvider?.level('gossip'), 'error');
});
