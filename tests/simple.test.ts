import { assertEquals } from 'std-latest/testing/asserts.ts';
import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config from '~/sbl/Config.ts';
import Peer from '~/sbl/Peer.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import { Answer } from '~/sbl/AnswerRegistry.ts';

const deadline = <Args extends any[], T>(
  func: (...args: Args) => Promise<T>,
  timeout = 1000,
) =>
  (...args: Args) =>
    new Promise<T>((resolve, reject) => {
      const idx = setTimeout(
        () => reject(new Error(`Timeout of ${timeout}ms exceeded`)),
        timeout,
      );
      func(...args).finally(() => clearTimeout(idx)).then(resolve, reject);
    });

const baseConfig: Config = {
  location: { x: 1, y: 2, z: 3 },

  shouldVerify: (ctx: Context, fromPeer: Peer, pub: any) => true,

  contracts: [],

  generators: [],

  networkProvider: {
    protocols: new Map(Object.entries({})),
  },

  trustedPeers: [],

  selfPrivateKey: secp.utils.randomPrivateKey(),
  nodeNonce: (new TextEncoder()).encode('server_0'),
};

Deno.test(
  `simple request/response test`,
  deadline(async () => {
    const ctx = new Context(baseConfig);

    const firstAnswer: Answer = await new Promise((resolve) =>
      ctx.get(QuestionService).getCanonical({
        contract_answer_hash: Hash.random(),
        params: new Uint8Array([]),
      }, resolve)
    );

    assertEquals(firstAnswer.data, new Uint8Array([]));
  }),
);
