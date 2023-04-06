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
import MockTimeProvider from './MockTimeProvider.ts';
import ServingService from '../sbl/ServingService.ts';
import ConnectionService from '../sbl/ConnectionService.ts';

const makeConfig = (
  ctxIdx: number,
  partialConfig: Partial<Config & { timeProvider: MockTimeProvider }>,
) => ({
  ...defaultConfig,

  debugName: `ctx_${ctxIdx + 1}`,

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

  timeProvider: new MockTimeProvider(),

  ...partialConfig,
} satisfies Config);

export const makeTest = (
  partialConfig: Partial<Config & { timeProvider: MockTimeProvider }>,
  func: (
    testCtx: Deno.TestContext,
    ...ctx: Context[]
  ) => Promise<void> | void,
) =>
(testCtx: Deno.TestContext) => {
  // const config = deepMerge(baseConfig, deepMerge({ log }, partialConfig));
  const ctxs = Array.from(
    { length: func.length - 1 },
    (_, i) => {
      const config = makeConfig(i, partialConfig);
      const stepperIdx = setInterval(() => config.timeProvider.stepTime(), 0);
      const ctx = new Context(config);
      ctx.onDestruct(() => {
        clearInterval(stepperIdx);
        config.timeProvider.destruct();
      });
      return ctx;
    },
  );
  return deadline(Promise.resolve(func(testCtx, ...ctxs)), 1000)
    .finally(() => ctxs.forEach((ctx) => ctx.destruct()));
};

export const connectCtxs = (ctxs: Context[], topology: 'chain' | 'mesh') => {
  switch (topology) {
    case 'chain':
      ctxs.forEach((ctx, idx) =>
        ctx.get(ServingService).serve((protocol: string, spec: string) =>
          idx && ctxs[idx - 1].get(ConnectionService).connect(protocol, spec)
        )
      );
      break;

    case 'mesh':
      ctxs.forEach((ctx1) =>
        ctxs.forEach((ctx2) =>
          ctx1.get(ServingService).serve((protocol: string, spec: string) =>
            ctx2.get(ConnectionService).connect(protocol, spec)
          )
        )
      );
      break;
  }
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

    await new Promise<void>((resolve) =>
      ctx.config.timeProvider.setTimeout(resolve, intervalMs)
    );
  }
};
