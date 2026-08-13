import { parseArgs } from '@std/cli/parse-args';
import { Scaffold, ScaffoldConfig } from '../Scaffold.ts';
import { Hash } from '../util/Hash.ts';
import { bin2str, str2bin } from '../util/buffer.ts';
import { createSource } from '../contract/createSource.ts';
import { Source, SourceRoot, ValueType } from '../contract/values.ts';
import { todo } from '../util/functional.ts';
import { makeDefaultConfig } from '../Config.ts';
import { GeneratorRole } from '../roles/GeneratorRole.ts';
import { WebsocketClientTransport } from '../../plugins/WebsocketClientTransport.ts';
import { TextLoggingProvider } from '../../plugins/TextLoggingProvider.ts';
import { Gossip } from '../peer/network/Gossip.ts';
import { Transport } from '../peer/network/Transport.ts';

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
  /** Write text to stderr verbatim; the caller supplies any trailing newline. */
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

const DEFAULT_TIMEOUT_MS = 10_000;

function parseArgv(argv: string[]) {
  const parsed = parseArgs(argv.slice(1), {
    boolean: ['help', 'version'],
    string: [
      'private_key_file',
      'genesis_block_file',
      'bootstrap_urls',
      'verbosity',
      'timeout',
      // Positionals too: without this an all-digit hash ('1111...') is coerced to a
      // JS number and reaches the contract as '1.1111111111111112e+63'.
      '_',
    ],
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
    try {
      switch (action) {
        case undefined:
          this.usage(program);
          return EXIT_CODES.USAGE;

        case 'help':
          this.usage(program);
          return EXIT_CODES.OK;

        case 'put':
          return await this.put(parsed);

        case 'fetch':
          return await this.fetch(parsed);

        default:
          this.deps.stderr(`${program}: unknown command '${action}'\n`);
          this.usage(program);
          return EXIT_CODES.USAGE;
      }
    } catch (err) {
      if (err instanceof UsageError) {
        this.deps.stderr(`${program}: ${err.message}\n`);
        return EXIT_CODES.USAGE;
      }
      throw err;
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
      `  put <contract_hash> <params_path> <body_path>`,
      `                      Run a contract over the given params and body,`,
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
      `      --verbosity <spec>          Log to stderr, e.g. 'warn' or`,
      `                                  'warn,gossip=debug'. Also \$SCAFFOLD_LOG`,
      `      --timeout <ms>              Give up waiting for a peer or a result`,
      `                                  after this long (default ${DEFAULT_TIMEOUT_MS})`,
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

    // Diagnostics go to stderr so stdout carries only the command's result.
    // Absent both the flag and the env var, config.loggingProvider stays
    // undefined and no subsystem logs at all.
    const verbosity = args.verbosity ?? this.deps.env('SCAFFOLD_LOG');
    if (verbosity !== undefined) {
      config.loggingProvider = new TextLoggingProvider(
        (line) => this.deps.stderr(line),
        verbosity,
      );
    }

    const scaffold = this.deps.constructScaffold(config);

    if (args.bootstrap_urls !== undefined) {
      scaffold.getContext().get(Gossip);
      scaffold.startTransport(new WebsocketClientTransport());
      for (const url of args.bootstrap_urls.split(',')) {
        scaffold.connect(url);
      }
    }

    return scaffold;
  }

  private parseTimeout(args: ParsedArgs): number {
    if (args.timeout === undefined) return DEFAULT_TIMEOUT_MS;
    const ms = Number(args.timeout);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new UsageError(
        `--timeout takes a positive number of milliseconds, got '${args.timeout}'`,
      );
    }
    return ms;
  }

  // `connect` is fire-and-forget and the handshake takes a few milliseconds, so a
  // command that starts work immediately raced it and always lost: `put` built its
  // block and exited before the socket opened (nothing was ever gossiped), and
  // `fetch` returned before any peer could answer. Blocks built before the
  // connection opens are still covered -- `Gossip.backfill` sends them on connect.
  private waitForPeer(scaffold: Scaffold, timeoutMs: number): Promise<boolean> {
    const ctx = scaffold.getContext();
    const time = ctx.config.timeProvider;
    const transport = ctx.get(Transport);
    if (transport.getOpenConnections().size > 0) return Promise.resolve(true);

    return new Promise((resolve) => {
      const subscription = new AbortController();
      const timer = time.setTimeout(() => {
        subscription.abort();
        resolve(false);
      }, timeoutMs);

      transport.onConnection(() => {
        time.clearTimeout(timer);
        subscription.abort();
        resolve(true);
      }, subscription.signal);
    });
  }

  private async connectOrReport(parsed: ParsedArgs, scaffold: Scaffold, timeoutMs: number) {
    if (parsed.bootstrap_urls === undefined) return true;
    if (await this.waitForPeer(scaffold, timeoutMs)) return true;
    this.deps.stderr(`scaffold: no peer connected within ${timeoutMs}ms\n`);
    return false;
  }

  private async createSourceFromFs(
    base: { open(name: string): Promise<FsNode | FsMissing> },
    name: string,
  ): Promise<Source> {
    const node = await base.open(name);
    if (node.type === FsNodeType.File) {
      return { type: ValueType.Bytes, value: await node.read() };
    } else if (node.type === FsNodeType.Directory) {
      const list = await node.list();
      return {
        type: ValueType.Map,
        length: list.length,
        entry: async (idx, _desc) => {
          const item = list[idx];
          if (item === undefined) return undefined;
          const value = await this.createSourceFromFs(node, item.name);
          return { key: item.name, value };
        },
        at: (key, _desc) => {
          if (key === '.' || key === '..') return undefined;
          return this.createSourceFromFs(node, key);
        },
      };
    }

    const jsonNode = await base.open(name + '.json');
    if (jsonNode.type === FsNodeType.File) {
      const value = JSON.parse(bin2str(await jsonNode.read()));
      return createSource(value);
    } else if (jsonNode.type === FsNodeType.Directory) {
      throw new Error(`Cannot open ${name}: ${name}.json is a directory`);
    }

    throw new Error(`Cannot open ${name} or ${name}.json: No such file or directory`);
  }

  private createSourceFromArg(arg: string): SourceRoot {
    arg = arg.trim();
    if (/^\.*\//.test(arg)) {
      return () => this.createSourceFromFs(this.deps, arg);
    } else if (
      (arg[0] === '[' && arg[arg.length - 1] === ']') ||
      (arg[0] === '{' && arg[arg.length - 1] === '}')
    ) {
      return () => createSource(JSON.parse(arg));
    } else {
      return () => ({ type: ValueType.String, value: arg });
    }
  }

  private async put(parsed: ParsedArgs): Promise<number> {
    if (parsed.positional.length !== 3) {
      throw new UsageError(
        '`scaffold put [contract_hash] [params_path] [body_path]` takes 3 positional arguments',
      );
    }
    const [contractHash, params, body] = parsed.positional;
    const timeoutMs = this.parseTimeout(parsed);

    const scaffold = await this.constructScaffold(parsed);
    try {
      if (!await this.connectOrReport(parsed, scaffold, timeoutMs)) {
        return EXIT_CODES.UNAVAILABLE;
      }

      await scaffold.put({
        contract: Hash.fromHex(contractHash),
        params: this.createSourceFromArg(params),
        result: this.createSourceFromArg(body),
        onBlock: (block) => {
          const output = block !== undefined
            ? {
              type: 'put_canonical',
              hash: block.hash.toHex(),
            }
            : { type: 'put_pending' };
          this.deps.stdout(str2bin(JSON.stringify(output, null, 2) + '\n'));
        },
      });

      return EXIT_CODES.OK;
    } finally {
      // Closing shuts the sockets down gracefully, which flushes the block we
      // just flooded before the host process exits.
      await scaffold.close();
    }
  }

  private async fetch(parsed: ParsedArgs): Promise<number> {
    if (parsed.positional.length !== 2) {
      throw new UsageError(
        '`scaffold fetch [contract_hash] [params_path]` takes 2 positional arguments',
      );
    }
    const [contractHash, params] = parsed.positional;
    const timeoutMs = this.parseTimeout(parsed);

    const scaffold = await this.constructScaffold(parsed);
    try {
      if (!await this.connectOrReport(parsed, scaffold, timeoutMs)) {
        return EXIT_CODES.UNAVAILABLE;
      }

      const contract = Hash.fromHex(contractHash);
      const source = this.createSourceFromArg(params);
      const time = scaffold.getContext().config.timeProvider;

      // `fetch` is a subscription, but a command has to finish: take the first
      // answer and abort. The abort is also what cancels the query draft, which
      // otherwise keeps retrying on every ingest if it stalled on placement.
      const query = new AbortController();
      const result = await new Promise<Uint8Array | undefined>((resolve, reject) => {
        const timer = time.setTimeout(() => {
          query.abort();
          resolve(undefined);
        }, timeoutMs);

        scaffold.fetch({
          contract,
          params: source,
          signal: query.signal,
          onResult: (result) => {
            if (result === null) return;
            time.clearTimeout(timer);
            query.abort();
            resolve(result.body);
          },
        }).catch(reject);
      });

      if (result === undefined) {
        this.deps.stderr(`scaffold: no result within ${timeoutMs}ms\n`);
        return EXIT_CODES.UNAVAILABLE;
      }

      this.deps.stdout(result);

      // Print a newline
      this.deps.stdout(new Uint8Array([10]));

      return EXIT_CODES.OK;
    } finally {
      await scaffold.close();
    }
  }
}
