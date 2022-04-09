import { assertEquals } from 'std-latest/testing/asserts.ts';
import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config from '~/sbl/Config.ts';
import Peer from '~/sbl/Peer.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import AnswerRegistry, { Answer } from '~/sbl/AnswerRegistry.ts';
import { loadHash } from '~/sbl/hashes.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';

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

const supplyRawAnswer = (ctx: Context, answer: Uint8Array) => {
  const hash = Hash.digest(answer);

  return ctx.get(AnswerRegistry).getByPub({
    question: { contract_answer_hash: loadHash, params: hash.toBytes() },
    inputs: [],
    answer,
    licenses: [],
    timestamp: BigInt(Date.now()),
  });
};

const supplyContract = (
  ctx: Context,
  contract: (
    contractHash: Hash,
    params: Uint8Array,
    hint: Uint8Array,
    request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
  ) => boolean,
) => supplyRawAnswer(ctx, new TextEncoder().encode(contract.toString()));

// TODO: Does this work? Depends on how answer consistency is handled in caller.
const getGeneratorContract = (ctx: Context) =>
  supplyContract(ctx, (
    _contractHash: Hash,
    params: Uint8Array, // This is the contract hash we're generating for.
    hint: Uint8Array, // This is the params we're evaluating at.
    request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
  ) =>
    eval(new TextDecoder().decode(request(loadHash, params)))(
      params,
      hint,
      new Uint8Array([]),
      request,
    ));

const supplyGenerator = (
  ctx: Context,
  contract: Answer,
  generator: (
    contractHash: Hash,
    params: Uint8Array,
    emitCorrect: boolean,
    request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
  ) => Uint8Array,
) =>
  ctx.get(AnswerRegistry).getByPub({
    question: {
      contract_answer_hash: getGeneratorContract(ctx).hash,
      params: contract.hash.toBytes(),
    },
    inputs: [],
    answer: new TextEncoder().encode(generator.toString()),
    licenses: [],
    timestamp: BigInt(Date.now()),
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

    const contract = supplyContract(ctx, contractFunc);
    supplyGenerator(ctx, contract, generatorFunc);

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
