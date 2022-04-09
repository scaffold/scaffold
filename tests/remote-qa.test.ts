import { assertEquals } from 'std-latest/testing/asserts.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import AnswerRegistry, { Answer } from '~/sbl/AnswerRegistry.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import CollatzContract from '~/graph/CollatzContract.ts';
import { CollatzAnswer } from '~/graph/collatzMessages.ts';
import { makeTest } from './util.ts';
import { ConnectionProvider, ProtocolProvider } from '~/sbl/NetworkProvider.ts';
import ServingService from '~/sbl/ServingService.ts';
import { makeMockNetworkProvider } from './mockNetwork.ts';
import ConnectionService from '~/sbl/ConnectionService.ts';

const mockNetworkProvider = makeMockNetworkProvider({
  connectLatencyMs: 25,
  sendReliableLatencyMs: 10,
  sendFastLatencyMs: 5,
  sendFastDropRatio: 0.1,
});

Deno.test(
  { name: `network put/get test`, sanitizeOps: false },
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

    const contractHash = Hash.fromLiteralStr('contract');
    const params = new TextEncoder().encode('params');
    const data = new TextEncoder().encode('data');

    const question = { contract_answer_hash: contractHash, params };

    // Add answer to ctx1's registry
    ctx1.get(AnswerRegistry).getByPub({
      question,
      inputs: [],
      answer: data,
      licenses: [],
      timestamp: BigInt(Date.now()),
    });

    // Query on ctx2
    const firstAnswer: Answer = await new Promise((resolve) =>
      ctx2.get(QuestionService).getCanonical(question, resolve)
    );

    assertEquals(firstAnswer.data, data);
  }),
);
