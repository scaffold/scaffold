import { parseArgs } from '@std/cli/parse-args';
import { Scaffold } from '../src/Scaffold.ts';
import { WebsocketServerTransport } from '../plugins/deno/WebsocketServerTransport.ts';
import { makeDefaultConfig } from '../src/Config.ts';
import { Gossip } from '../src/peer/network/Gossip.ts';
import { BlockStore } from '../src/graph/BlockStore.ts';
import { neverAbort } from '../src/util/abortable.ts';

const flags = parseArgs(Deno.args, { string: ['port'] });
const port = flags.port ? Number(flags.port) : 8314;

const scaffold = new Scaffold({
  ...makeDefaultConfig(),
  roles: [Gossip],
});

scaffold.getContext().get(BlockStore).onIngest(
  (x) => console.log(x.hash.toHex(), x.raw.byteLength),
  neverAbort,
);

scaffold.startTransport(new WebsocketServerTransport({ port }), (signal) => {
  console.log(`WebSocket announce: ${signal}`);
});

console.log(`signaling hub listening ws://127.0.0.1:${port}/`);
