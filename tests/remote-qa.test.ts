import { assertEquals } from 'std-latest/testing/asserts.ts';
import Hash from '~/sbl/util/Hash.ts';
import { makeTest } from './util.ts';
import ServingService from '~/sbl/ServingService.ts';
import { makeMockNetworkProvider } from './mockNetwork.ts';
import ConnectionService, { SELF_CONNECTION } from '~/sbl/ConnectionService.ts';
import CollatzContract from '~/graph/CollatzContract.ts';
import * as collatzMessages from '~/graph/collatzMessages.ts';
import LocalGeneratorService from '../sbl/LocalGeneratorService.ts';
import * as moduleHashes from '../ts/moduleHashes.ts';
import collatzGenerator from '../ts/collatz.generator.0.ts';
import FetchService from '../sbl/FetchService.ts';
import { Block } from '../sbl/messages.ts';

const mockNetworkProvider = makeMockNetworkProvider({
  connectLatencyMs: 25,
  sendReliableLatencyMs: 10,
  sendFastLatencyMs: 5,
  sendFastDropRatio: 0.1,
});

Deno.test(
  {
    name: `network request/reply test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    networkProvider: {
      protocols: new Map(Object.entries({ mock: mockNetworkProvider })),
    },
  }, async (_testCtx, ctx1, ctx2) => {
    const ctxs = [ctx1, ctx2];

    // Only add the generator to one of the contexts
    ctx1.get(LocalGeneratorService).addGenerator(
      moduleHashes.collatz_wasm_hash,
      collatzGenerator,
    );

    ctxs.forEach((ctx, idx) =>
      ctx.get(ServingService).serve((protocol: string, spec: string) =>
        idx && ctxs[idx - 1].get(ConnectionService).connect(protocol, spec)
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const block = await new Promise<Block>((resolve) =>
      ctx2.get(FetchService).fetch(
        {
          contract_hash: moduleHashes.collatz_wasm_hash,
          params: collatzMessages.Params.encode({ num: 10n }),
        },
        {},
        resolve,
      )
    );

    const answer = Object.assign({}, collatzMessages.Answer.decode(block.body));
    assertEquals(answer, { stopping_time: 6n, maximum: 16n });
  }),
);
