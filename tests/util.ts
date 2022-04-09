import { deadline } from 'std-fix-abortable/async/mod.ts';
import { deepMerge } from 'std-latest/collections/mod.ts';
import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config from '~/sbl/Config.ts';
import Peer from '~/sbl/Peer.ts';

const baseConfig: Config = {
  location: { x: 1, y: 2, z: 3 },

  shouldVerify: (ctx: Context, fromPeer: Peer, pub: any) => true,

  networkProvider: {
    protocols: new Map(Object.entries({})),
  },

  trustedPeers: [],

  selfPrivateKey: secp.utils.randomPrivateKey(),
  nodeNonce: (new TextEncoder()).encode('test_0'),
};

export const makeTest = (
  partialConfig: Partial<Config>,
  func: (...ctx: Context[]) => Promise<void> | void,
) =>
  () => {
    const config = deepMerge(baseConfig, partialConfig);
    const ctxs = Array.from({ length: func.length }, () => new Context(config));
    return deadline(Promise.resolve(func(...ctxs)), 1000).finally(() =>
      ctxs.forEach((ctx) => ctx.destruct())
    );
  };
