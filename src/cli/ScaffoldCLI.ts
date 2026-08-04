import { parseArgs } from '@std/cli/parse-args';
import { Scaffold, ScaffoldConfig } from '../Scaffold.ts';
import { Hash } from '../util/Hash.ts';
import { bin2str, EMPTY_ARR, str2bin } from '../util/buffer.ts';
import { createSource } from '../contract/createSource.ts';
import { Source, ValueType } from '../contract/values.ts';
import { todo } from '../util/functional.ts';
import { makeDefaultConfig } from '../Config.ts';
import { GeneratorRole } from '../roles/GeneratorRole.ts';

export enum FsNodeType {
  Missing = 0,
  Directory = 1,
  File = 2,
}

export interface DirNode {
  type: FsNodeType.Directory;
  list(): Promise<({ name: string } & FsNode)[]>;
  open(name: string): Promise<FsNode | FsMissing>;
}

export interface FileNode {
  type: FsNodeType.File;
  read(): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
}

export type FsNode = DirNode | FileNode;

export interface FsMissing {
  type: FsNodeType.Missing;
  error: Error;
}

/**
 * Host capabilities the CLI needs, injected by the caller.
 *
 * Keeping these behind an interface is what lets `ScaffoldCLI` run unchanged in
 * Node, Deno, and the browser: only the thin shim that constructs the deps is
 * platform-specific. See `scripts/cli.ts` for the filesystem-backed
 * implementation shared by both shell runtimes; a browser host can back them
 * with OPFS, an in-memory map, fetch, etc.
 *
 * The interface stays intentionally small and free of Node/Deno types so the
 * module itself imports nothing platform-specific.
 */
export interface ScaffoldCliDeps {
  /** Create a scaffold instance */
  constructScaffold(config: ScaffoldConfig): Scaffold;
  /** Opens a filesystem path */
  open(path: string): Promise<FsNode | FsMissing>;
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
    const parsed = parseArgv(argv);

    if (parsed.version) {
      this.deps.stdout(str2bin(`${this.deps.version}\n`));
      return EXIT_CODES.OK;
    }

    if (parsed.help) {
      this.usage(program);
      return EXIT_CODES.OK;
    }

    const action = parsed.positional.shift();
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
  }

  /** Read the command payload from a positional file path, or stdin if absent. */
  private async readInput(path?: string): Promise<Uint8Array> {
    if (path === undefined || path === '-') return this.deps.readStdin();
    const node = await this.deps.open(path);
    if (node.type === FsNodeType.File) return node.read();
    throw new Error(`Cannot read file at ${path}`);
  }

  /** print help */
  private usage(program: string) {
    const message = [
      `${program} -- Scaffold command line`,
      ``,
      `Usage:`,
      `  ${program} <command> [options]`,
      ``,
      `Commands:`,
      `  put <contract_hash> <params_path> <records_path>`,
      `                      Run a contract over the given params and records,`,
      `                      publish the block, and print its hash and record outputs`,
      `  fetch <contract_hash> <params_path>`,
      `                      Resolve and verify a contract output via a node and`,
      `                      write the result body to stdout`,
      `  help                Show this help`,
      ``,
      `Options:`,
      `  -h, --help                      Show help`,
      `  -v, --version                   Show version`,
      `      --private_key_file <path>   Private key for signing blocks`,
      `      --bootstrap_urls <a,b,...>  Comma-separated bootstrap node URLs`,
      `      --genesis_block_file <path> Genesis block (not yet implemented)`,
      `      --verbosity <level>         Log verbosity (not yet implemented)`,
      ``,
    ].join('\n');
    this.deps.stdout(str2bin(message));
  }

  private async constructScaffold(args: ParsedArgs): Promise<Scaffold> {
    const config: ScaffoldConfig = makeDefaultConfig();

    config.roles = [GeneratorRole];

    // string: ['private_key_file', 'genesis_block_file', 'bootstrap_urls', 'verbosity'],

    if (args.private_key_file !== undefined) {
      config.selfPrivateKey = await this.readInput(args.private_key_file);
    }
    if (args.genesis_block_file !== undefined) {
      todo('genesis_block_file option not yet implemented');
    }
    if (args.verbosity !== undefined) {
      todo('verbosity option not yet implemented');
    }

    const scaffold = this.deps.constructScaffold(config);

    if (args.bootstrap_urls !== undefined) {
      for (const url of args.bootstrap_urls.split(',')) {
        scaffold.connect(url);
      }
    }

    return scaffold;
  }

  private async createSourceFromFs(
    base: { open(name: string): Promise<FsNode | FsMissing> },
    name: string,
  ): Promise<Source> {
    if (name === '.' || name === '..') throw new Error(`Invalid open key ${name}`);

    const node = await base.open(name);
    if (node.type === FsNodeType.File) {
      return { type: ValueType.Bytes, value: await node.read() };
    } else if (node.type === FsNodeType.Directory) {
      const list = await node.list();
      return {
        type: ValueType.List,
        length: list.length,
        at: (idx, _desc) => ({
          type: ValueType.Struct,
          at: (key, _desc) =>
            key === 'key'
              ? { type: ValueType.String, value: list[idx].name }
              : key === 'value'
              ? this.createSourceFromFs(node, key)
              : undefined,
        }),
      };
    }

    const jsonNode = await base.open(name + '.json');
    if (jsonNode.type === FsNodeType.File) {
      const value = JSON.parse(bin2str(await jsonNode.read()));
      return createSource(value);
    } else if (jsonNode.type === FsNodeType.Directory) {
      throw new Error(`Cannot open ${name}: name.json is a directory`);
    }

    throw new Error(`Cannot open ${name}:\n  ${node.error.message}\n  ${jsonNode.error.message}`);
  }

  private async put(parsed: ParsedArgs) {
    if (parsed.positional.length !== 3) {
      throw new UsageError(
        '`scaffold put [contract_hash] [params_path] [records_path]` takes 3 positional arguments',
      );
    }
    const [contractHash, params, records] = parsed.positional;

    const scaffold = await this.constructScaffold(parsed);

    /*
    const result = await scaffold.put({
      contract: Hash.fromHex(contractHash),
      params: () => this.createSourceFromFs(this.deps, params),
      records: {},
    });

    const output = {
      hash: result.hash.toHex(),
    };

    this.deps.stdout(str2bin(JSON.stringify(output, null, 2) + '\n'));
    */
  }

  private async fetch(parsed: ParsedArgs) {
    if (parsed.positional.length !== 2) {
      throw new UsageError(
        '`scaffold fetch [contract_hash] [params_path]` takes 2 positional arguments',
      );
    }
    const [contractHash, params] = parsed.positional;

    const scaffold = await this.constructScaffold(parsed);

    await scaffold.fetch({
      contract: Hash.fromHex(contractHash),
      params: () => this.createSourceFromFs(this.deps, params),
      onResult: (result) => {
        this.deps.stdout(result?.body ?? new Uint8Array());
        this.deps.stdout(new Uint8Array([10]));
      },
    });
  }
}
