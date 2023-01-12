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

console.log('postMessage', self.postMessage.toString());
const client = new WorkerChannelClient<WorkerComm>(self, sigBuf);

while (true) {
  console.log('Worker is ready...');
  client.inform('ready', [], []);
  const msg = await popMsg<JobMessage>();

  if (msg.data) {
    console.log('Worker received job...');
    if (arrEquals(msg.data.code.subarray(0, 4), wasmMagic)) {
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
