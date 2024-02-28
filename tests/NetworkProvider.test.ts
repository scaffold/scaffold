import { assertEquals } from '$std/assert/mod.ts';
import { NetworkService } from '../src/NetworkService.ts';
import { makeTest } from './util.ts';

Deno.test(
  { name: `NetworkProvider test` },
  makeTest({}, async (_testCtx, ctx1, ctx2) => {
    if (
      ctx1.maybeGet(NetworkService) !== undefined ||
      ctx2.maybeGet(NetworkService) !== undefined
    ) {
      throw new Error(
        `Constructed a NetworkService before we added providers!`,
      );
    }
    ctx1.config.networkProviders.push({ protocols: 'abc', createInstance(); });
    ctx2.config.networkProviders.push({ protocols: 'abc' });
  }),
);
