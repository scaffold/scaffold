import { log, secp } from '../deps.ts';
import Context from '../src/Context.ts';
import { makeDefaultConfig } from '../src/Config.ts';
import WebsocketServerProvider from '../plugins/WebsocketServerProvider.ts';
import WebsocketClientProvider from '../plugins/WebsocketClientProvider.ts';
import NetworkService from '../src/NetworkService.ts';
import NullStorageProvider from '../plugins/NullStorageProvider.ts';

const ctx = new Context({
  ...makeDefaultConfig(),

  debugName: 'signaling server',

  selfPrivateKey: secp.utils.randomPrivateKey(),

  logLevel: log.LogLevels.INFO,

  networkProviders: [
    new WebsocketServerProvider(),
    new WebsocketClientProvider(),
  ],

  storageProvider: new NullStorageProvider(),

  enableBlockIngestion: false,
});

ctx.get(NetworkService).initConnection(
  'websocket@0.0.1',
  undefined,
  (signal) => console.log(`Listening on ${signal}`),
);
