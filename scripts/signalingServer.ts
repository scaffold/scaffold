import { parseArgs } from '@std/cli/parse-args';
import { Scaffold } from '../src/Scaffold.ts';
import { WebsocketServerTransport } from '../plugins/deno/WebsocketServerTransport.ts';
import { makeDefaultConfig } from '../src/Config.ts';
import { Gossip, GossipConfig } from '../src/peer/network/Gossip.ts';
import { GeneratorRole, GeneratorRoleConfig } from '../src/roles/GeneratorRole.ts';
import { BlockStore } from '../src/graph/BlockStore.ts';
import { TextLoggingProvider } from '../plugins/TextLoggingProvider.ts';
import { neverAbort } from '../src/util/abortable.ts';

const flags = parseArgs(Deno.args, {
  string: ['hostname', 'port', 'publicOrigins', 'verbosity'],
});

const config = makeDefaultConfig();
if (flags.verbosity !== undefined) {
  config.loggingProvider = new TextLoggingProvider(
    (line) => Deno.stderr.writeSync(new TextEncoder().encode(line)),
    flags.verbosity,
  );
}

const scaffold = new Scaffold({
  ...config,
  roles: [Gossip, GeneratorRole],
});

scaffold.getContext().get(BlockStore).onIngest(
  // deno-lint-ignore no-console
  (x) => console.log(x.hash.toHex(), x.raw.byteLength),
  neverAbort,
);

scaffold.startTransport(
  new WebsocketServerTransport({
    hostname: flags.hostname,
    port: flags.port !== undefined ? Number(flags.port) : undefined,
    publicOrigins: flags.publicOrigins !== undefined ? flags.publicOrigins.split(',') : undefined,
  }, scaffold.getContext().logger('websocket_server_transport')),
  (signal) => {
    // deno-lint-ignore no-console
    console.log(`WebSocket announce: ${signal}`);
  },
);
