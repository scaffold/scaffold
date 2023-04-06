import * as msg from './messages.ts';
import Hash from '~/sbl/util/Hash.ts';
import { makeTest } from './util.ts';
import BlockService from '../sbl/BlockService.ts';
import { assertSnapshot } from 'std-latest/testing/snapshot.ts';
import FetchService from '../sbl/FetchService.ts';
import LocalGeneratorService, {
  LocalGenerator,
} from '../sbl/LocalGeneratorService.ts';
import ExecutorDriverService from '../sbl/ExecutorDriverService.ts';
import ExecutorLauncherService from '../sbl/ExecutorLauncherService.ts';

const infiniteChainContractHash = Hash.random();
const infiniteChainGenerator: LocalGenerator = (
  { ctx, contractHash, params, request },
) =>
  request(
    contractHash,
    msg.InfiniteChainParams.encode({
      x: msg.InfiniteChainParams.decode(params).x + 1n,
    }),
  );

Deno.test(
  { name: `ingest should add block to our registry` },
  makeTest({}, async (testCtx, ctx) => {
    ctx.get(LocalGeneratorService).addGenerator(
      infiniteChainContractHash,
      infiniteChainGenerator,
    );

    await new Promise<void>((resolve, reject) => {
      ctx.get(FetchService).fetch(
        {
          contract_hash: infiniteChainContractHash,
          params: msg.InfiniteChainParams.encode({ x: 0n }),
        },
        {},
        (_block) => reject('Should not have resolved!'),
      );

      ctx.config.timeProvider.setTimeout(resolve, 250);
    });

    await assertSnapshot(testCtx, ctx.get(BlockService).snapshot());
    await assertSnapshot(testCtx, ctx.get(ExecutorLauncherService).snapshot());
    await assertSnapshot(testCtx, ctx.get(ExecutorDriverService).snapshot());
  }),
);
