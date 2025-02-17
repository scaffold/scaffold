import { Context } from '../src/Context.ts';
import { makeDefaultConfig } from '../src/Config.ts';
import { WebsocketServerProvider } from '../plugins/deno/WebsocketServerProvider.ts';
import { WebsocketClientProvider } from '../plugins/WebsocketClientProvider.ts';
import { NetworkService } from '../src/NetworkService.ts';
import { NullStorageProvider } from '../plugins/NullStorageProvider.ts';
import { hex2bin } from '../src/util/hex.ts';
import { BlockIngestor } from '../src/ingestors/BlockIngestor.ts';
import { defaultIngestionProviders } from '../src/ingestors/defaultIngestionProviders.ts';

const ctx = new Context({
  ...makeDefaultConfig(),

  debugName: 'signaling server',
  userdata: JSON.stringify({ name: 'signaling server' }),

  selfPrivateKey: hex2bin(
    '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784',
  ),

  networkProviders: [
    new WebsocketServerProvider(),
    new WebsocketClientProvider(),
  ],

  storageProvider: new NullStorageProvider(),

  ingestionProviders: defaultIngestionProviders.filter((x) => x !== BlockIngestor),
});

ctx.get(NetworkService).initConnection(
  'websocket@0.0.1/server',
  (signal) => console.log(`Listening on ${signal}`),
);
