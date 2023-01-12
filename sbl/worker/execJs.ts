import Hash from '../util/Hash.ts';
import { WorkerChannelClient } from './WorkerChannel.ts';
import { JobMessage, WorkerComm } from './workerTypes.ts';

let transferBuf = new Uint8Array(65536);

export default async (
  client: WorkerChannelClient<WorkerComm>,
  { code, inputs }: JobMessage,
) => {
  client.inform('init', ['ext', 0], []);

  const handler = (contractHash: Hash, params: Uint8Array): Uint8Array => {
    client.inform('open', [0, contractHash.toBytes(), 0n, 1], []);
    client.inform('open', [1, params, 0n, 2], []);
    const len = client.dispatch('getSize', [2], []);
    if (len > transferBuf.byteLength) {
      transferBuf = new Uint8Array(len);
    }
    client.dispatch('read', [2, 0, [transferBuf]], []);
    return transferBuf.subarray(0, len);
  };
  const notifier = (contractHash: Hash, params: Uint8Array) => {
    client.inform('open', [0, contractHash.toBytes(), 0n, 1], []);
    client.inform('open', [1, params, 0n, 2], []);
  };

  const func = eval(new TextDecoder().decode(code));
  if (typeof func !== 'function') {
    throw new Error(`Script is not a function`);
  }
  const out: Uint8Array = await func(
    inputs.contractHash,
    inputs.params,
    inputs.emitCorrect,
    handler,
    notifier,
  );

  client.inform('result', [out], []);
};
