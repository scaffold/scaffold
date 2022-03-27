import { makeClient } from './client.ts';
import ClientId from './ClientId.ts';
import Context from './Context.ts';
import Hash from './util/Hash.ts';

const contracts = [
  {
    name: 'increment',
    func: (
      params: any,
      answer: any,
      request: (contractName: string, params: any) => any,
    ) => {
      return (
        JSON.stringify({ ...params, value: params.value + 1 }) ===
          JSON.stringify(answer)
      );
    },
  },

  {
    name: 'collatz',
    func: (
      params: any,
      answer: any,
      request: (contractName: string, params: any) => any,
    ) => {
      if (params.num === 1) {
        return answer === 0;
      } else {
        return (
          answer ===
            request('collatz', {
                num: params.num % 2 ? params.num * 3 + 1 : params.num / 2,
              }) +
              1
        );
      }
    },
  },
];

const generators = [
  {
    name: 'increment',
    contractName: 'increment',
    isCorrect: true,
    func: (
      params: any,
      request: (contractName: string, params: any) => any,
    ) => ({ ...params, value: params.value + 1 }),
  },
  {
    name: 'increment',
    contractName: 'increment',
    isCorrect: false,
    func: (
      params: any,
      request: (contractName: string, params: any) => any,
    ) => ({ ...params, value: params.value - 100 }),
  },

  {
    name: 'collatz',
    contractName: 'collatz',
    isCorrect: true,
    func: (params: any, request: (contractName: string, params: any) => any) =>
      request('collatz', {
        num: params.num % 2 ? params.num * 3 + 1 : params.num / 2,
      }),
  },
  {
    name: 'collatz',
    contractName: 'collatz',
    isCorrect: false,
    func: (params: any, request: (contractName: string, params: any) => any) =>
      123,
  },
];

const sender = (senderId: ClientId) =>
  (dstAddr: string, data: any) => {
    const src = clients.find((c) => c.config.selfId === senderId)!;
    const dst = clients.find((c) => c.config.selfId.addr === dstAddr)!;

    const greatCircleDist = Math.acos(
      src.config.location.x * dst.config.location.x +
        src.config.location.y * dst.config.location.y +
        src.config.location.z * dst.config.location.z,
    );
    const travelTime = greatCircleDist * 1000 + Math.random() * 100;

    setTimeout(
      () => dst.recv(senderId.addr, senderId.publicKey, data),
      travelTime,
    );
  };

const clients = await Promise.all(
  [...new Array(4)].map(async (_, i) => {
    const selfId = {
      name: `client_${i}`,
      hash: await Hash.digest(`client_${i}`),
      addr: `addr.${i}.client.com`,
      publicKey: `public_key_${i}`,
    };
    return makeClient({
      selfId,
      location: {
        x: Math.random() - 0.5,
        y: Math.random() - 0.5,
        z: Math.random() - 0.5,
      },
      initialPublicMetadata: {
        name: `client_${i}`,
        implName: 'ts-proto',
        protocolVersion: 1,
        agePtr: `/transaction/${Math.floor(Math.random() * 1e6)}`,
      },
      trustVec: new Map(),
      forwardingFee: 0,
      peerJudgementCollateral: 1000,
      shouldVerify: (ctx: Context, fromPeer: ClientId, pub: any) =>
        fromPeer === ctx.config.selfId || Math.random() < 0.5,
      contracts,
      generators,
      send: sender(selfId),
    });
  }),
);

// Inform each client of one other
// clients.forEach((c, i) => i && c.recv(clients[i - 1].config.selfId.id, {}));

// clients
//   .find((c) => c.config.selfId.id === `client_0`)!
//   .fetch('epoch', { epoch: 10 }, (val) => console.log('epoch', val));

self.addEventListener('unload', () => {
  console.log('Exiting...');
  clients.forEach((c) => {
    c.dump('  ');
    c.close();
  });
  console.log('Done!');
});
