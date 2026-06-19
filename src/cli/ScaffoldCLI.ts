import { parseArgs } from '@std/cli/parse-args';
import { Scaffold, ScaffoldConfig } from '../Scaffold.ts';
import { Hash } from '../util/Hash.ts';
import { unimplemented } from '@std/assert/unimplemented';
import { RECORD_CONTRACT } from '../core/Block.ts';
import { bin2str, EMPTY_ARR, str2bin } from '../util/buffer.ts';

/**
 * Host capabilities the CLI needs, injected by the caller.
 *
 * Keeping these behind an interface is what lets `ScaffoldCLI` run unchanged in
 * Node, Deno, and the browser: only the thin shim that constructs the deps is
 * platform-specific. See `scripts/cli-bin.ts` (Node, the shell binary) and
 * `scripts/cli.ts` (Deno) for the filesystem-backed implementations; a browser
 * host can back them with OPFS, an in-memory map, fetch, etc.
 *
 * The interface stays intentionally small and free of Node/Deno types so the
 * module itself imports nothing platform-specific.
 */
export interface ScaffoldCliDeps {
  /** Create a scaffold instance */
  constructScaffold(config: ScaffoldConfig): Scaffold;
  /** Read a file as bytes. Should reject if the file does not exist. */
  readFile(path: string): Promise<Uint8Array>;
  /** Write bytes to a file, creating or truncating it. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Read all of stdin as bytes (empty array if nothing is piped). */
  readStdin(): Promise<Uint8Array>;
  /** Write binary data to stdout. */
  stdout(data: Uint8Array): void;
  /** Write a line of text to stderr. */
  stderr(line: string): void;
  /** Look up an environment variable, or undefined if unset. */
  env(name: string): string | undefined;
  /** Version string reported by `scaffold --version`. */
  version: string;
}

/** Thrown for malformed input; mapped to EXIT_CODES.USAGE by `call`. */
class UsageError extends Error {}

const EXIT_CODES = {
  OK: 0,
  GENERIC_ERROR: 1,
  USAGE: 64,
  UNAVAILABLE: 69,
};

function parseArgv(argv: string[]) {
  const parsed = parseArgs(argv.slice(1), {
    boolean: ['help', 'version'],
    string: ['private_key_file', 'genesis_block_file', 'bootstrap_urls', 'verbosity'],
    alias: { h: 'help', v: 'version' },
  });
  return { ...parsed, _: undefined, positional: parsed._.map(String) };
}
type ParsedArgs = ReturnType<typeof parseArgv>;

/**
 * The Scaffold CLI as a pure object: construct it with a set of host
 * capabilities, then drive it with `call(argv)`. It performs no I/O except
 * through the injected `deps`, so the same instance works in a shell, a test,
 * or a browser tab.
 */
export class ScaffoldCLI {
  constructor(private readonly deps: ScaffoldCliDeps) {}

  /**
   * Run one invocation. `argv[0]` is the program name (used only for help and
   * error text); the rest is the command and its flags. Mirrors a shell call,
   * e.g. `cli.call(['scaffold', 'put', './contract.wasm'])`.
   *
   * Resolves to the process exit code. Ordinary user errors are reported to
   * stderr and returned as a code -- they do not throw.
   */
  async call(argv: string[]): Promise<number> {
    const program = argv[0] ?? 'scaffold';

    let parsed: ParsedArgs;
    try {
      parsed = parseArgv(argv);
    } catch (err) {
      this.deps.stderr(`${program}: ${messageOf(err)}`);
      return EXIT_CODES.USAGE;
    }

    if (parsed.version) {
      this.deps.stdout(str2bin(`${this.deps.version}\n`));
      return EXIT_CODES.OK;
    }

    if (parsed.help) {
      this.usage(program);
      return EXIT_CODES.OK;
    }

    const action = parsed.positional.shift();
    try {
      switch (action) {
        case undefined:
          this.usage(program);
          return EXIT_CODES.USAGE;

        case 'help':
          this.usage(program);
          return EXIT_CODES.OK;

        case 'put':
          await this.put(parsed);
          return EXIT_CODES.OK;

        case 'fetch':
          await this.fetch(parsed);
          return EXIT_CODES.OK;

        default:
          this.deps.stderr(`${program}: unknown command '${action}'\n`);
          this.usage(program);
          return EXIT_CODES.USAGE;
      }
    } catch (err) {
      // Never drop the error silently -- surface it to the user.
      const code = err instanceof UsageError ? EXIT_CODES.USAGE : EXIT_CODES.GENERIC_ERROR;
      this.deps.stderr(`${program}: ${messageOf(err)}`);
      return code;
    }
  }

  /** Read the command payload from a positional file path, or stdin if absent. */
  private async readInput(path?: string): Promise<Uint8Array> {
    return path === undefined || path === '-'
      ? await this.deps.readStdin()
      : await this.deps.readFile(path);
  }

  /** print help */
  private usage(program: string) {
    const message = [
      // TODO(claude): Update the help text
      `${program} -- Scaffold command line`,
      ``,
      `Usage:`,
      `  ${program} <command> [options]`,
      ``,
      `Commands:`,
      `  put [<file>]        Hash a contract/payload (file or stdin) and print its id`,
      `  fetch <hash>        Resolve a hash to its data via a node`,
      `  help                Show this help`,
      ``,
      `Options:`,
      `  -h, --help          Show help`,
      `  -v, --version       Show version`,
      `      --params <json> Contract params (fetch)`,
      `      --connect <url> Node to connect to (fetch)`,
      `  -o, --output <file> Write output to a file instead of stdout`,
      ``,
    ].join('\n');
    this.deps.stdout(str2bin(message));
  }

  private async constructScaffold(args: ParsedArgs): Promise<Scaffold> {
    const config: ScaffoldConfig = {};

    // string: ['private_key_file', 'genesis_block_file', 'bootstrap_urls', 'verbosity'],

    if (args.private_key_file !== undefined) {
      config.privateKey = await this.readInput(args.private_key_file);
    }
    if (args.genesis_block_file !== undefined) {
      unimplemented('genesis_block_file option not yet implemented');
    }
    if (args.bootstrap_urls !== undefined) {
      config.bootstrapUrls = args.bootstrap_urls.split(',');
    }
    if (args.verbosity !== undefined) {
      unimplemented('verbosity option not yet implemented');
    }

    return this.deps.constructScaffold(config);
  }

  private async put(parsed: ParsedArgs) {
    if (parsed.positional.length !== 3) {
      throw new UsageError(
        '`scaffold put [contract_hash] [params_path] [records_path]` takes 3 positional arguments',
      );
    }
    const [contractHash, params, records] = parsed.positional;

    const scaffold = await this.constructScaffold(parsed);

    const result = await scaffold.put({
      contract: Hash.fromHex(contractHash),
      params: { files: { '/main.js': '' } },
      records: {},
    });

    const output = {
      hash: result.hash.toHex(),
      records: result.outputs.filter((x) => Hash.equals(x.verifier.contract, RECORD_CONTRACT))
        .map((x) => [bin2str(x.verifier.params), bin2str(x.body ?? EMPTY_ARR)]),
    };

    this.deps.stdout(str2bin(JSON.stringify(output, null, 2) + '\n'));
  }

  private async fetch(parsed: ParsedArgs) {
    if (parsed.positional.length !== 2) {
      throw new UsageError(
        '`scaffold fetch [contract_hash] [params_path]` takes 2 positional arguments',
      );
    }
    const [contractHash, params] = parsed.positional;

    const scaffold = await this.constructScaffold(parsed);

    const result = await scaffold.fetch({
      contract: Hash.fromHex(contractHash),
      params: { files: { '/main.js': '' } },
      verify: true,
    });
    this.deps.stdout(result.body);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
