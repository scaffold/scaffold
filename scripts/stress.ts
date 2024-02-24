import * as log from '$std/log/mod.ts';
import { Context } from '../src/Context.ts';
import { Config, makeDefaultConfig } from '../src/Config.ts';
import { hex2bin } from '../src/util/hex.ts';
import { NullStorageProvider } from '../plugins/NullStorageProvider.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';
import { GenesisService, sharedGenesisData } from '../src/GenesisService.ts';
import { FactService } from '../src/FactService.ts';

const config: Config = {
  ...makeDefaultConfig(),

  debugName: 'stress',
  // userdata: JSON.stringify({ epochStartTime }),
  // selfPrivateKey: secp.utils.randomPrivateKey(),
  selfPrivateKey: hex2bin(
    '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784',
  ),

  logLevel: log.LogLevels.WARN,

  networkProviders: [],

  // storageProvider: new DenoKvStorageProvider(),
  storageProvider: new NullStorageProvider(),
};

const ctx = new Context(config);

ctx.get(GenesisService).ingestGenesis(sharedGenesisData);

const start = Date.now();
let count = 0;
const cb = () => {
  ctx.get(BlockBuilder).publishSingleDraft({});
  count++;
  const duration = Date.now() - start;
  console.log(
    `Published ${count} blocks in ${duration / 1000} seconds (${
      Math.round(count / duration * 1000)
    } blocks/sec); ${ctx.get(FactService).getSize()} remain`,
  );
};
setInterval(cb, 1);
