import { parseArgs } from '@std/cli/parse-args';
import { Scaffold } from '../src/Scaffold.ts';
import { WebsocketServerTransport } from '../plugins/deno/WebsocketServerTransport.ts';
import { makeDefaultConfig } from '../src/Config.ts';

const flags = parseArgs(Deno.args, { string: ['port'] });
const port = flags.port ? Number(flags.port) : 8314;

const scaffold = new Scaffold({
  ...makeDefaultConfig(),
});

scaffold.startTransport(new WebsocketServerTransport({ port }), (signal) => {
  // deno-lint-ignore no-console
  console.log(`WebSocket announce: ${signal}`);
});

// deno-lint-ignore no-console
console.log(`signaling hub listening ws://127.0.0.1:${port}/`);

// setTimeout(() => scaffold.close(), 1000);
