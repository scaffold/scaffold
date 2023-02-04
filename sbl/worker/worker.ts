import { WorkerChannelClient } from './WorkerChannel.ts';
import { InitialMessage, JobMessage, WorkerComm } from './workerTypes.ts';
import execJob from './execJob.ts';
import execJs from './execJs.ts';
import { arrEquals } from '../util/buffer.ts';

console.log('Worker starting...');

const wasmMagic = new Uint8Array([0, 0x61, 0x73, 0x6D]);

const msgQueue: MessageEvent<any>[] = [];
const cbQueue: ((msg: MessageEvent<any>) => void)[] = [];
self.onmessage = (msg: MessageEvent<any>) => {
  const cb = cbQueue.shift();
  if (cb) {
    cb(msg);
  } else {
    msgQueue.push(msg);
  }
};
const popMsg = <T>() => {
  const msg = msgQueue.shift();
  if (msg) {
    return msg as MessageEvent<T>;
  } else {
    return new Promise<MessageEvent<T>>((resolve) => cbQueue.push(resolve));
  }
};

const { sigBuf } = (await popMsg<InitialMessage>()).data;

// console.log('postMessage', self.postMessage.toString());
const client = new WorkerChannelClient<WorkerComm>(self, sigBuf);

// const readMagic = (verifier: JobMessage['codeVerifier']) => {
//   client.inform('init', ['ext', 0], []);
//   client.inform('open', [0, verifier.contractHash, 0n, 1], []);
//   client.inform('open', [1, verifier.params, 0n, 2], []);
//   const transferBuf = new Uint8Array(
//     new SharedArrayBuffer(wasmMagic.byteLength),
//   );
//   client.dispatch('read', [2, 0, [transferBuf]], []);
//   return transferBuf;
// };

while (true) {
  console.log('Worker is ready...');
  client.inform('ready', [], []);
  const msg = await popMsg<JobMessage | undefined>();

  if (msg.data) {
    console.log('Worker received job...');

    if (
      arrEquals(
        // readMagic(msg.data.codeVerifier)
        msg.data.code.subarray(0, wasmMagic.byteLength),
        wasmMagic,
      )
    ) {
      await execJob(client, msg.data).catch((err) => console.error(err));
    } else {
      await execJs(client, msg.data).catch((err) => console.error(err));
    }
  } else {
    break;
  }
}

client.inform('exit', [], []);
console.log('Worker finished!');
