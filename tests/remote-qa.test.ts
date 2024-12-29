import { assertEquals, assertStrictEquals } from '@std/assert';
import { connectCtxs, makeTest, provideInitialBalance } from './util.ts';
import { FetchService } from '../src/FetchService.ts';
import { collatzHash } from '../src/constants.ts';
import { CollatzContract } from '../src/contracts/CollatzContract.ts';
import * as collatzMessages from '../src/contracts/collatzMessages.ts';
import { MockNetworkProvider } from '../plugins/MockNetworkProvider.ts';
import { MockTimeProvider } from '../tests/MockTimeProvider.ts';
import { AccountContract } from '../src/contracts/AccountContract.ts';
import { DataContract } from '../src/contracts/DataContract.ts';
import { error } from '../src/util/functional.ts';

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
    ignore: true,
  },
  makeTest({
    timeProvider,
    networkProviders: [new MockNetworkProvider(mockNetworkOptions)],
    contractProviders: [new AccountContract(), new DataContract()],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    // Only add the generator to one of the contexts
    ctx1.config.contractProviders.push(new CollatzContract());

    connectCtxs([ctx1, ctx2], 'chain');

    // TODO: We shouldn't need this
    await new Promise<void>((resolve) => ctx2.config.timeProvider.setTimeout(resolve, 100));

    const body = await new Promise<Uint8Array | undefined>((resolve) =>
      ctx2.get(FetchService).fetch(
        {
          contractHash: collatzHash,
          params: collatzMessages.Params.encode({ num: 1n }),
        },
        { onBody: resolve },
      )
    );

    const answer = collatzMessages.Answer.decode(body ?? error(`Empty body!`));
    assertEquals(answer, { stoppingTime: 0n, maximum: 1n });
  }),
);

Deno.test(
  {
    name: `network multi-req test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
    ignore: true,
  },
  makeTest({
    timeProvider,
    networkProviders: [new MockNetworkProvider(mockNetworkOptions)],
    contractProviders: [new AccountContract(), new DataContract()],
    limitFactCount: 100,
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    // Only add the generator to one of the contexts
    ctx1.config.contractProviders.push(new CollatzContract());

    connectCtxs([ctx1, ctx2], 'chain');

    // TODO: We shouldn't need this
    await new Promise<void>((resolve) => ctx2.config.timeProvider.setTimeout(resolve, 100));

    const body = await new Promise<Uint8Array | undefined>((resolve) =>
      ctx2.get(FetchService).fetch(
        {
          contractHash: collatzHash,
          params: collatzMessages.Params.encode({ num: 10n }),
        },
        { onBody: resolve },
      )
    );

    const answer = collatzMessages.Answer.decode(body ?? error(`Empty body!`));
    assertEquals(answer, { stoppingTime: 6n, maximum: 16n });
  }),
);
