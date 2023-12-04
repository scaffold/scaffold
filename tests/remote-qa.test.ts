import { assertEquals } from 'std-latest/assert/mod.ts';
import { connectCtxs, makeTest, provideInitialBalance } from './util.ts';
import * as collatzMessages from '~/ts/collatzMessages.ts';
import LocalGeneratorService from '../sbl/LocalGeneratorService.ts';
import * as moduleHashes from '../ts/moduleHashes.ts';
import collatzGenerator from '../ts/collatz.generator.0.ts';
import FetchService from '../sbl/FetchService.ts';
import { Block } from '../sbl/messages.ts';
import MockNetworkProvider from '~/plugins/MockNetworkProvider.ts';
import MockTimeProvider from '~/tests/MockTimeProvider.ts';
import AccountContract from '~/sbl/contracts/AccountContract.ts';
import DataContract from '~/sbl/contracts/DataContract.ts';

const timeProvider = new MockTimeProvider();
const mockNetworkOptions = {
  timeProvider,
  connectLatencyMs: 25,
  sendReliableLatencyMs: 10,
  sendFastLatencyMs: 5,
  sendFastDropRatio: 0.1,
};

Deno.test(
  {
    name: `network single request/reply test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    timeProvider,
    networkProviders: [new MockNetworkProvider(mockNetworkOptions)],
    contractProviders: [new AccountContract(), new DataContract()],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    // Only add the generator to one of the contexts
    ctx1.get(LocalGeneratorService).addGenerator(
      moduleHashes.collatz_wasm_hash,
      collatzGenerator,
    );

    connectCtxs([ctx1, ctx2], 'chain');

    // TODO: We shouldn't need this
    await new Promise<void>((resolve) =>
      ctx2.config.timeProvider.setTimeout(resolve, 100)
    );

    const block = await new Promise<Block>((resolve) =>
      ctx2.get(FetchService).fetch(
        {
          contract_hash: moduleHashes.collatz_wasm_hash,
          params: collatzMessages.Params.encode({ num: 1n }),
        },
        {},
        resolve,
      )
    );

    const answer = collatzMessages.Answer.decode(block.body);
    assertEquals(answer, { stopping_time: 0n, maximum: 1n });
  }),
);

Deno.test(
  {
    name: `network multi-req test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
    only: true,
  },
  makeTest({
    timeProvider,
    networkProviders: [new MockNetworkProvider(mockNetworkOptions)],
    contractProviders: [new AccountContract(), new DataContract()],
    limitFactCount: 100,
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    // Only add the generator to one of the contexts
    ctx1.get(LocalGeneratorService).addGenerator(
      moduleHashes.collatz_wasm_hash,
      collatzGenerator,
    );

    connectCtxs([ctx1, ctx2], 'chain');

    // TODO: We shouldn't need this
    await new Promise<void>((resolve) =>
      ctx2.config.timeProvider.setTimeout(resolve, 100)
    );

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

    const answer = collatzMessages.Answer.decode(block.body);
    assertEquals(answer, { stopping_time: 6n, maximum: 16n });
  }),
);
