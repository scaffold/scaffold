import { assertEquals } from '@std/assert';
import { makeTest } from './util.ts';
import { OrchestrationService } from '../src/OrchestrationService.ts';
import { encodeDataTree } from '../src/DataTreeHelper.ts';
import { NameContract } from '../src/contracts/NameContract.ts';
import { AvailableOutputManager } from '../src/AvailableOutputManager.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';

Deno.test(
  { name: `OrchestrationService test` },
  makeTest(
    {
      contractProviders: [NameContract],
      allow: [OrchestrationService, AvailableOutputManager, BlockBuilder],
    },
    async (_testCtx, ctx) => {
      ctx.get(AvailableOutputManager).popAll = () => [];
      ctx.get(BlockBuilder).publishSingleDraft = () => ({
        hash: Hash.fromHex('0x123'),
        timestamp: 0,
        body: encodeDataTree({ value: 'Hello test!' }),
      });

      const result = await ctx.get(OrchestrationService).launchGenerator({
        contractHash: NameContract.contractHash,
        params: NameContract.encodeParams({ name: 'test' }),
      });

      assertEquals(result, encodeDataTree({ value: 'Hello test!' }));
    },
  ),
);
