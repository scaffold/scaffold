// Deno entry point for the `scaffold` binary. Like scripts/cli-bin.ts (the Node
// shim), this only builds a filesystem-backed `ScaffoldCliDeps` and delegates
// to the pure `ScaffoldCLI`. Install with:
//   deno install -gA -n scaffold scripts/cli.ts
import { readAll } from '@std/io';
import { ScaffoldCLI } from '../src/cli/ScaffoldCLI.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { str2bin } from '../src/util/buffer.ts';

const cli = new ScaffoldCLI({
  constructScaffold: (config) => new Scaffold(config),
  readFile: (path) => Deno.readFile(path),
  writeFile: (path, data) => Deno.writeFile(path, data),
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
