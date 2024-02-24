import * as log from '$std/log/mod.ts';
import { Context } from '../src/Context.ts';
import { makeDefaultConfig } from '../src/Config.ts';
import { WebsocketServerProvider } from '../plugins/WebsocketServerProvider.ts';
import { WebsocketClientProvider } from '../plugins/WebsocketClientProvider.ts';
import { NetworkService } from '../src/NetworkService.ts';
import { NullStorageProvider } from '../plugins/NullStorageProvider.ts';
import { hex2bin } from '../src/util/hex.ts';

const ctx = new Context({
  ...makeDefaultConfig(),

  debugName: 'signaling server',

  selfPrivateKey: hex2bin(
    '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784',
  ),

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
