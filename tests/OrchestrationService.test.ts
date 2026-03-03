import { assertEquals } from '@std/assert';
import { makeTest } from './util.ts';
import { OrchestrationService } from '../legacy2/OrchestrationService.ts';
import { encodeDataTree } from '../legacy2/DataTreeHelper.ts';
import { NameContract } from '../src/contracts/NameContract.ts';
import { AvailableOutputManager } from '../legacy2/AvailableOutputManager.ts';
import { BlockBuilder } from '../legacy2/BlockBuilder.ts';

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
