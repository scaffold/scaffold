import AccountContract from '../../src/contracts/AccountContract.ts';
import { BlockFact } from '../../src/FactMeta.ts';
import Hash from '../../src/util/Hash.ts';
import Context from '../../src/Context.ts';
import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'std-latest/assert/mod.ts';
import BlockService from '../../src/BlockService.ts';
import { findOutput } from '../util.ts';

export const baseContractProviders = [new AccountContract()];

export const waitForVerifiedOutput = async (
  ctx: Context,
  block: BlockFact,
  outputContractHash: Hash,
  shouldExist = true,
) => {
  const { outputIdx } = findOutput(block, outputContractHash);

  const controller = new AbortController();
  const consumerPromise = ctx.get(BlockService).waitForConsumption(
    { block_hash: block.hash, output_idx: outputIdx },
    controller.signal,
  );

  const consumer = await Promise.race([
    consumerPromise,
    new Promise<undefined>((resolve) =>
      setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, 1000)
    ),
  ]);

  if (shouldExist) {
    assertNotEquals(consumer, undefined);
    assert(await ctx.get(BlockService).waitForVerification(consumer!));
    return consumer!;
  } else {
    assertEquals(consumer, undefined);
  }
};
