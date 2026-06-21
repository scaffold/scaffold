// Deno entry point for the `scaffold` binary. Like scripts/cli-bin.ts (the Node
// shim), this only builds a filesystem-backed `ScaffoldCliDeps` and delegates
// to the pure `ScaffoldCLI`. Install with:
//   deno install -gA -n scaffold scripts/cli.ts
import { readAll } from '@std/io';
import { FsNode, FsNodeType, ScaffoldCLI } from '../src/cli/ScaffoldCLI.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { str2bin } from '../src/util/buffer.ts';
import { join } from '@std/path/join';

async function openPath(path: string): Promise<FsNode | { type: FsNodeType.Missing }> {
  let isDirectory: boolean;
  try {
    ({ isDirectory } = await Deno.stat(path));
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
        const nodes: ({ name: string } & FsNode)[] = [];
        for await (const entry of Deno.readDir(path)) {
          nodes.push({ name: entry.name, ...makeNode(join(path, entry.name), entry.isDirectory) });
        }
        return nodes;
      },
      open(key) {
        return openPath(join(path, key));
      },
    };
  } else {
    return {
      type: FsNodeType.File,
      read() {
        return Deno.readFile(path);
      },
      write(data: Uint8Array) {
        return Deno.writeFile(path, data);
      },
    };
  }
}

const cli = new ScaffoldCLI({
  constructScaffold: (config) => new Scaffold(config),
  open: openPath,
  readStdin: () => readAll(Deno.stdin),
  stdout: (data) => {
    Deno.stdout.writeSync(data);
  },
  stderr: (line) => {
    Deno.stderr.writeSync(str2bin(line + '\n'));
  },
  env: (name) => Deno.env.get(name),
  version: '0.0.1',
});

const code = await cli.call(['scaffold', ...Deno.args]);
Deno.exit(code);
