import { Context } from '../src/Context.ts';
import { makeDefaultConfig } from '../src/Config.ts';
import { NullStorageProvider } from '../plugins/NullStorageProvider.ts';
import { RenderService } from '../src/RenderService.ts';
import { GenesisService, sharedGenesisData } from '../src/GenesisService.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';
import { bin2hex, hex2bin } from '../src/util/hex.ts';
import { FrontierContract } from '../legacy2/contracts/FrontierContract.ts';
import { GraphUtilityService } from '../src/GraphUtilityService.ts';
import { ZERO_BLOCK } from '../src/BlockMeta.ts';

const ctx = new Context({
  ...makeDefaultConfig(),

  selfPrivateKey: hex2bin(
    '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784',
  ),
  networkProviders: [],
  storageProvider: new NullStorageProvider(),
  contractProviders: [],
});

const genesis = ctx.get(GenesisService).ingestGenesis(sharedGenesisData);

const a = ctx.get(GraphUtilityService).addBlock(ZERO_BLOCK);
const b = ctx.get(GraphUtilityService).addBlock(ZERO_BLOCK, [genesis, a]);
const c = ctx.get(GraphUtilityService).addBlock(b);
const d = ctx.get(GraphUtilityService).addBlock(ZERO_BLOCK);
const e = ctx.get(GraphUtilityService).addBlock(b, [c, d]);
const f = ctx.get(GraphUtilityService).addBlock(ZERO_BLOCK, [b, e]);

await Deno.writeTextFile(
  './render.svg',
  await ctx.get(RenderService).renderSvg(),
);
