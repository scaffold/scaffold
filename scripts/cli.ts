import { parse } from 'std-latest/flags/mod.ts';
import { error } from '../src/util/functional.ts';
import { readAll } from 'std-latest/streams/read_all.ts';

class DenoInterface {
  public getArgs() {
    return Deno.args;
  }

  public readStdin() {
    return readAll(Deno.stdin);
  }
}
class NodeJsInterface {
  public getArgs() {
    return (globalThis as any).process.argv.slice(2);
  }

  public readStdin() {
    return new Promise<Uint8Array>((resolve, reject) => {
      (globalThis as any).require('fs').readFile(
        (globalThis as any).process.stdin.fd,
        (err: unknown, data: Uint8Array) => err ? reject(err) : resolve(data),
      );
    });
  }
}

const world = 'Deno' in globalThis
  ? new DenoInterface()
  : 'process' in globalThis
  ? new NodeJsInterface()
  : error('Cannot find cli args');

const flags = parse(world.getArgs(), {
  boolean: ['help'],
  alias: {},
  collect: ['private-keys', 'connect-to'],
  string: [
    'network',
    'userdata',
    'identity',
    'private-keys',
    'log-level',
    'storage-directory',
    'worker-count',
    'connect-to',
    'contract-hash',
    'params',
  ],
  default: {},
});

const stack = flags._;

const action = stack.shift();
switch (action) {
  case undefined:
    console.log('Default action');
    break;

  case 'pub':
    console.log('pub');
    world.readStdin().then((x) => console.log(x));
    break;

  case 'fetch':
    console.log('fetch');
    break;

  default:
    console.error(`Invalid action ${action}`);
}

// cat contract.wasm | npx scaffold pub
// echo ef2b26a3ba27a3b2a116eebd775ddd62ebbbbc462c5a0caaa83c354ec8d3e5e4 | npx scaffold fetch --params '{a: 123, b: 456}'

// deno bundle --check --config=deno.json cli/index.ts /tmp/cli.js ;and node /tmp/cli.js --params 123 --contract-hash 456 abc
// deno run --check cli/index.ts --params 123 --contract-hash 3
