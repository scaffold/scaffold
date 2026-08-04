// import { Hash } from '../util/Hash.ts';
// import { WorkerChannel } from './WorkerChannel.ts';
// import { WorkerComm } from './workerTypes.ts';

// let transferBuf = new Uint8Array(new SharedArrayBuffer(65536));

// export const makeClientUtils = (client: WorkerChannel<WorkerComm>) => {
//   client.inform('init', ['ext', 0], []);

//   const callReader = (
//     name: 'readContractHash' | 'readParams' | 'readHint' | 'readBody',
//   ): Uint8Array => {
//     const size = client.dispatch(name, [new Uint8Array(), 0], []);
//     const arr = new Uint8Array(new SharedArrayBuffer(size));
//     client.dispatch(name, [arr, 0], []);
//     return arr;
//   };

//   const request = (contractHash: Hash, params: Uint8Array): Uint8Array => {
//     client.inform('open', [0, contractHash.toBytes(), 0n, 1], []);
//     client.inform('open', [1, params, 0n, 2], []);
//     const len = client.dispatch('getSize', [2], []);
//     if (len > transferBuf.byteLength) {
//       transferBuf = new Uint8Array(new SharedArrayBuffer(len));
//     }
//     client.dispatch('read', [2, [transferBuf], 0], []);
//     return transferBuf.subarray(0, len);
//   };

//   const notify = (contractHash: Hash, params: Uint8Array) => {
//     client.inform('open', [0, contractHash.toBytes(), 0n, 1], []);
//     client.inform('open', [1, params, 0n, 2], []);
//   };

//   const returnResult = (out: Uint8Array) =>
//     // client.inform('outputChunk', ['stdout', 0, out], []);
//     client.inform('requireBody', [out], []);

//   return { callReader, request, notify, returnResult };
// };
