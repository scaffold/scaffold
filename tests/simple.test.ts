import { assertEquals } from 'std-latest/testing/asserts.ts';
import { deadline } from 'std-fix-abortable/async/mod.ts';
import { deepMerge } from 'std-latest/collections/mod.ts';
import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config from '~/sbl/Config.ts';
import Peer from '~/sbl/Peer.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import AnswerRegistry, { Answer } from '~/sbl/AnswerRegistry.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import CollatzContract from '~/graph/CollatzContract.ts';
import { CollatzAnswer } from '~/graph/collatzMessages.ts';

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
  nodeNonce: (new TextEncoder()).encode('test_0'),
};

const makeTest = (
  func: (ctx: Context) => Promise<void> | void,
  partialConfig: Partial<Config> = {},
) =>
  () => {
    const ctx = new Context(deepMerge(baseConfig, partialConfig));
    return deadline(Promise.resolve(func(ctx)), 1000).finally(() =>
      ctx.destruct()
    );
  };

Deno.test(
  { name: `simple put/get test` },
  makeTest(async (ctx) => {
    const params = new TextEncoder().encode('params');
    const data = new TextEncoder().encode('data');
    const contractHash = Hash.fromLiteralStr('contract');

    const question = { contract_answer_hash: contractHash, params };

    ctx.get(AnswerRegistry).getByPub({
      question,
      inputs: [],
      answer: data,
      licenses: [],
      timestamp: BigInt(Date.now()),
    });

    const firstAnswer: Answer = await new Promise((resolve) =>
      ctx.get(QuestionService).getCanonical(question, resolve)
    );

    assertEquals(firstAnswer.data, data);
  }),
);

Deno.test(
  { name: `simple request/generate test` },
  makeTest(async (ctx) => {
    const contractFunc = (
      contractHash: Hash,
      params: Uint8Array,
      _hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => arrEquals(params, request(contractHash, params));

    const generatorFunc = (
      _contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => emitCorrect ? params : new TextEncoder().encode('DUPE');

    const contract = ctx.get(GraphUtils).supplyContract(contractFunc);
    ctx.get(GraphUtils).supplyGenerator(contract, generatorFunc);

    const params = new TextEncoder().encode('Sublime');

    const firstAnswer: Answer = await new Promise((resolve) =>
      ctx.get(QuestionService).getCanonical({
        contract_answer_hash: contract.hash,
        params,
      }, resolve)
    );

    assertEquals(firstAnswer.data, params);
  }),
);

Deno.test(
  { name: `recursion test` },
  makeTest(async (ctx) => {
    const params = ctx.get(CollatzContract).makeParams(10n);

    const firstAnswer: Answer = await new Promise((resolve) =>
      ctx.get(QuestionService).getCanonical({
        contract_answer_hash: ctx.get(CollatzContract).get().hash,
        params,
      }, resolve)
    );

    assertEquals(
      firstAnswer.data,
      CollatzAnswer.encode({ stopping_time: 6n, maximum: 16n }),
    );
  }),
);
