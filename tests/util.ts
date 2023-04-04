import { deadline } from 'std-fix-abortable/async/mod.ts';
import { deepMerge } from 'std-latest/collections/mod.ts';
import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config, { defaultConfig } from '~/sbl/Config.ts';
import Peer from '~/sbl/Peer.ts';
import NodeService from '~/sbl/NodeService.ts';
import BlockService from '../sbl/BlockService.ts';
import { Block, BlockInput } from '../sbl/messages.ts';
import { bin2hex } from '../sbl/pathUtils.ts';
// import DefaultAppraisalProvider from '~/sbl/DefaultAppraisalProvider.ts';
import { assertEquals, AssertionError } from 'std-latest/testing/asserts.ts';

let timestamp = 1000;

const makeConfig = (
  ctxIdx: number,
  partialConfig: Partial<Config>,
): Config => ({
  ...defaultConfig,

  debugName: `ctx_${ctxIdx + 1}`,

  log: {
    handler: (
      ctx: Context,
      className: string,
      methodName: string,
      params: Record<string, any>,
    ) => {},
  },

  location: { x: 1, y: 2, z: 3 },

  shouldVerify: (ctx: Context, fromPeer: Peer, pub: any) => true,

  networkProvider: {
    protocols: new Map(Object.entries({})),
  },

  // appraisalProvider: new DefaultAppraisalProvider(),

  trustedPeers: [],

  selfPrivateKey: secp.utils.randomPrivateKey(),
  nodeNonce: (new TextEncoder()).encode('test_0'),

  approxComputePricePerSecond: 1000n,

  initialWorkerCount: 16,

  computeContracts: [],

  timeProvider: {
    now: () => timestamp++,
    // TODO: Instant time simulation
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  },

  ...partialConfig,
});

export const makeTest = (
  partialConfig: Partial<Config>,
  func: (testCtx: Deno.TestContext, ...ctx: Context[]) => Promise<void> | void,
) =>
(testCtx: Deno.TestContext) => {
  // const config = deepMerge(baseConfig, deepMerge({ log }, partialConfig));
  const ctxs = Array.from(
    { length: func.length - 1 },
    (_, i) => new Context(makeConfig(i, partialConfig)),
  );
  return deadline(Promise.resolve(func(testCtx, ...ctxs)), 1000).finally(() =>
    Promise.all(ctxs.map((ctx) => ctx.destruct()))
  );
};

export const waitForBlock = async (
  ctx: Context,
  consuming: BlockInput,
  intervalMs = 100,
) => {
  while (true) {
    const blocks = ctx.get(BlockService).getBlocksByInput(consuming);
    if (blocks.length > 0) {
      if (blocks.length !== 1) {
        throw new Error(
          `More than one block consuming ${
            bin2hex(BlockInput.encode(consuming))
          }`,
        );
      }
      return blocks[0];
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
