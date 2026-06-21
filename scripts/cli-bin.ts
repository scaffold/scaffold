// deno-lint-ignore-file no-external-import -- this is the Node boundary; the
// `node:` specifiers are exactly what dnt needs to emit the npm `bin`.
// Node entry point for the `scaffold` shell binary. This is the only file that
// touches Node's filesystem/process APIs: it builds a `ScaffoldCliDeps` backed
// by the real OS and hands control to the pure `ScaffoldCLI`. dnt wires this up
// as the package `bin` (with a shebang), so `npm i -g scaffold.io` puts
// `scaffold` on the user's PATH.
import process from 'node:process';
import { join } from 'node:path';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { FsNode, FsNodeType, ScaffoldCLI } from '../src/cli/ScaffoldCLI.ts';
import { Scaffold } from '../src/Scaffold.ts';

async function openPath(path: string): Promise<FsNode | { type: FsNodeType.Missing }> {
  let isDirectory: boolean;
  try {
    const result = await stat(path);
    isDirectory = result.isDirectory();
  } catch (_err) {
    return { type: FsNodeType.Missing };
  }

  return makeNode(path, isDirectory);
}

function makeNode(path: string, isDirectory: boolean): FsNode {
  if (isDirectory) {
    return {
      type: FsNodeType.Directory,
      async list() {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((x) => ({
          name: x.name,
          ...makeNode(join(path, x.name), x.isDirectory()),
        }));
      },
      open(key) {
        return openPath(join(path, key));
      },
    };
  } else {
    return {
      type: FsNodeType.File,
      read() {
        return readFile(path);
      },
      write(data: Uint8Array) {
        return writeFile(path, data);
      },
    };
  }
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const cli = new ScaffoldCLI({
  constructScaffold: (config) => new Scaffold(config),
  open: openPath,
  readStdin,
  stdout: (data) => {
    process.stdout.write(data);
  },
  stderr: (line) => {
    process.stderr.write(line + '\n');
  },
  env: (name) => process.env[name],
  // TODO(@joel): inject the real package version at build time instead of
  // hardcoding it here (see TODO.md "CLI: report the real binary version").
  version: '0.0.1',
});

// No top-level await: dnt also emits a CommonJS build, where it is unavailable.
cli.call(['scaffold', ...process.argv.slice(2)])
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`scaffold: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
