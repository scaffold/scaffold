import { assertEquals } from 'std-latest/testing/asserts.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import AnswerRegistry, { Answer } from '~/sbl/AnswerRegistry.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { makeTest } from './util.ts';
import { ConnectionProvider, ProtocolProvider } from '~/sbl/NetworkProvider.ts';
import ServingService from '~/sbl/ServingService.ts';
import { makeMockNetworkProvider } from './mockNetwork.ts';
import ConnectionService, { SELF_CONNECTION } from '~/sbl/ConnectionService.ts';
import CollatzContract from '~/graph/CollatzContract.ts';
import * as collatzMessages from '~/graph/collatzMessages.ts';

const mockNetworkProvider = makeMockNetworkProvider({
  connectLatencyMs: 25,
  sendReliableLatencyMs: 10,
  sendFastLatencyMs: 5,
  sendFastDropRatio: 0.1,
});

Deno.test(
  {
    name: `network put/get test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false, // TODO: Turn this on
  },
  makeTest({
    networkProvider: {
      protocols: new Map(Object.entries({ mock: mockNetworkProvider })),
    },
  }, async (ctx1, ctx2) => {
    const ctxs = [ctx1, ctx2];

    ctxs.forEach((ctx, idx) =>
      ctx.get(ServingService).serve((protocol: string, spec: string) =>
        idx && ctxs[idx - 1].get(ConnectionService).connect(protocol, spec)
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const contractHash = Hash.fromLiteralStr('contract');
    const params = new TextEncoder().encode('params');
    const data = new TextEncoder().encode('data');

    const question = { contract_answer_hash: contractHash, params };

    // Add answer to ctx1's registry
    const putAnswer = ctx1.get(AnswerRegistry).getOrCreate({
      question,
      inputs: [],
      answer: data,
      licenses: [],
      timestamp: BigInt(Date.now()),
    }, SELF_CONNECTION);
    putAnswer.isCorrect = true;
    putAnswer.difficultyEstimate = 0n;

    // Query on ctx2
    const firstAnswer: Answer = await new Promise((resolve) => {
      const sub = ctx2.get(QuestionService).getCanonical(question);
      sub.incentivize(1000n);
      sub.onAnswer(resolve);
    });

    assertEquals(new Uint8Array(firstAnswer.data), data);
  }),
);

Deno.test(
  {
    name: `network req/reply test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false, // TODO: Turn this on
    only: true,
  },
  makeTest({
    networkProvider: {
      protocols: new Map(Object.entries({ mock: mockNetworkProvider })),
    },
  }, async (ctx1, ctx2) => {
    const ctxs = [ctx1, ctx2];

    ctxs.forEach((ctx, idx) =>
      ctx.get(ServingService).serve((protocol: string, spec: string) =>
        idx && ctxs[idx - 1].get(ConnectionService).connect(protocol, spec)
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Add contract to ctx1's registry
    const contract = ctx1.get(CollatzContract).get(false);

    // Add contract AND generator to ctx2's registry
    ctx2.get(CollatzContract).get(true);

    console.log(`CollatzContract hash: ${contract.hash.toHex()}`);

    // Query on ctx1
    const firstAnswer: Answer = await new Promise((resolve) => {
      const sub = ctx1.get(QuestionService).getCanonical({
        contract_answer_hash: contract.hash,
        params: ctx1.get(CollatzContract).makeParams(10n),
      });
      sub.incentivize(1000n);
      sub.onAnswer(resolve);
    });

    assertEquals(
      firstAnswer.data,
      collatzMessages.Answer.encode({ stopping_time: 6n, maximum: 16n }),
    );
  }),
);
