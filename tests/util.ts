import * as async from '$std/async/mod.ts';
import { secp } from '../src/util/secp.ts';
import { Context } from '../src/Context.ts';
import { Config, makeDefaultConfig } from '../src/Config.ts';
import { BlockService } from '../src/BlockService.ts';
import { BlockInput } from '../src/messages.ts';
import { bin2hex } from '../src/util/hex.ts';
// import { DefaultAppraisalProvider } from '../../sbl/DefaultAppraisalProvider.ts';
import { MockTimeProvider } from './MockTimeProvider.ts';
import { ConnectionService } from '../src/ConnectionService.ts';
import { NullStorageProvider } from '../plugins/NullStorageProvider.ts';
import { NetworkService } from '../src/NetworkService.ts';
import { KeyService } from '../src/KeyService.ts';
import { createGenesisBlock, GenesisService } from '../src/GenesisService.ts';
import { FactService } from '../src/FactService.ts';
import { BlockFact, FactSource } from '../src/FactMeta.ts';
import { PeerManager } from '../src/PeerManager.ts';
import { NotUndefined } from '../src/util/functional.ts';
import { InputSpec } from '../src/BlockBuilder.ts';
import { Hash } from '../src/util/Hash.ts';
import { arrEquals } from '../src/util/buffer.ts';
import { SignalingProvider } from '../src/NetworkProvider.ts';

const makeConfig = (
  ctxIdx: number,
  partialConfig: Partial<Config & { timeProvider: MockTimeProvider }>,
) => ({
  ...makeDefaultConfig(),

  debugName: `ctx_${ctxIdx + 1}`,
  selfPrivateKey: secp.utils.randomPrivateKey(),

  workerPath: new URL('./worker/worker.ts', import.meta.url).href,

  timeProvider: new MockTimeProvider(),
  storageProvider: new NullStorageProvider(),
  networkProviders: [],

  limitFactCount: 10,

  ...partialConfig,
} satisfies Config);

export const makeTest = (
  partialConfig: Partial<Config & { timeProvider: MockTimeProvider }>,
  func: (
    testCtx: Deno.TestContext,
    ...ctx: Context[]
  ) => Promise<void> | void,
) =>
async (testCtx: Deno.TestContext) => {
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

  try {
    await async.deadline(Promise.resolve(func(testCtx, ...ctxs)), 1000);
  } finally {
    for (const ctx of ctxs) {
      await ctx.destruct();
    }
  }
};

export const provideInitialBalance = (...ctxs: Context[]) => {
  const genesis = createGenesisBlock(
    ctxs.map((ctx) => ({
      publicKey: ctx.get(KeyService).getSelfPublicKey(),
      amount: 1000000n,
    })),
  );

  for (const ctx of ctxs) {
    ctx.get(GenesisService).ingestGenesis(genesis);
  }

  return Hash.digest(genesis);
};

const connectPair = (a: Context, b: Context) => {
  let bProvider: SignalingProvider | undefined;
  const bMessages: string[] = [];

  const aProvider = a.get(NetworkService).initConnection(
    'mock',
    undefined,
    (signal) =>
      bProvider !== undefined
        ? bProvider.recvSignal(signal)
        : bMessages.push(signal),
  );

  bProvider = b.get(NetworkService).initConnection(
    'mock',
    undefined,
    (signal) => aProvider.recvSignal(signal),
  );
  for (const msg of bMessages) {
    bProvider.recvSignal(msg);
  }
};

export const connectCtxs = (ctxs: Context[], topology: 'chain' | 'mesh') => {
  switch (topology) {
    case 'chain':
      ctxs.forEach((ctx, idx) => idx && connectPair(ctx, ctxs[idx - 1]));
      break;

    case 'mesh':
      ctxs.forEach((ctx1) => ctxs.forEach((ctx2) => connectPair(ctx1, ctx2)));
      break;
  }
};

export const blockConsuming = (ctx: Context, input: BlockInput) => {
  const blocks = ctx.get(BlockService).getBlocksByInput(input);
  if (blocks.length > 0) {
    if (blocks.length !== 1) {
      throw new Error(
        `More than one block consuming ${bin2hex(BlockInput.encode(input))}`,
      );
    }
    return blocks[0];
  }
};

export const waitFor = async <T extends NotUndefined>(
  ctx: Context,
  filter: (ctx: Context) => T | undefined,
  intervalMs = 100,
) => {
  while (true) {
    const res = filter(ctx);
    if (res !== undefined) {
      return res;
    }

    await new Promise<void>((resolve) =>
      ctx.config.timeProvider.setTimeout(resolve, intervalMs)
    );
  }
};

export const findOutput = (
  block: BlockFact,
  contractHash: Hash,
  params?: Uint8Array,
): InputSpec => {
  for (const [idx, output] of block.outputs.entries()) {
    if (
      Hash.equals(output.verifier.contractHash, contractHash) &&
      (params === undefined || arrEquals(output.verifier.params, params))
    ) {
      return { block, outputIdx: idx, amount: output.amount };
    }
  }
  throw new Error(`No output matches!`);
};
